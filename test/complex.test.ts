import { describe, expect, it } from 'vitest';
import { run } from '../src/interp/fn';
import { toFilter, toOData } from '../src/interp/odata';
import { any, eq, starts } from '../src/pred';
import { pick, query, where } from '../src/query';
import { isComplex, keyProps, schema } from '../src/schema';
import { store } from '../src/store';
import { validate } from '../src/validate';
import { alfreds, nw, type Address, type Customer } from './fixtures';

const berlinAddr: Address = { street: 'Obere Str. 57', city: 'Berlin', zip: '12209' };
const berlin: Customer = {
  ...alfreds,
  address: berlinAddr,
  phones: [
    { kind: 'work', number: '+49 30 0074321' },
    { kind: 'fax', number: '+49 30 0076545' },
  ],
};
const london: Customer = {
  id: 3,
  name: 'Around the Horn',
  city: 'London',
  address: { street: '120 Hanover Sq.', city: 'London', zip: 'WA1 1DP' },
  phones: [{ kind: 'work', number: '+44 171 555 7788' }],
};

describe('schema', () => {
  it('treats keyless types as complex and guards references', () => {
    expect(isComplex(nw, 'Address')).toBe(true);
    expect(isComplex(nw, 'Customer')).toBe(false);
    expect(() => keyProps(nw, 'Address')).toThrow(/complex type/);
    expect(() => schema({ A: { key: 'id', props: { x: 'Nope' } } })).toThrow(/unknown type "Nope"/);
    expect(() => schema({ A: { key: 'id', props: { b: 'B' } }, B: { key: 'id' } })).toThrow(/entity type/);
    expect(() =>
      schema({ V: { props: { x: 'string' }, navs: { a: { to: 'A', fk: 'aId' } } }, A: { key: 'id' } }),
    ).toThrow(/navigations/);
  });

  it('refuses to add a complex type to the store', () => {
    expect(() => store(nw).add('Address', berlinAddr)).toThrow(/complex type/);
  });
});

describe('queries over complex values', () => {
  const rows = [berlin, london];

  it('filters and projects on dotted paths locally', () => {
    expect(run(query<Customer>('Customer', where(eq('address.city', 'London'))), rows).map((c) => c.id)).toEqual([3]);
    expect(run(query<Customer>('Customer', where(any('phones', starts('number', '+49')))), rows).map((c) => c.id)).toEqual([1]);
    expect(run(query<Customer>('Customer', where(eq('id', 1)), pick('name', 'address.zip')), rows)).toEqual([
      { name: alfreds.name, 'address.zip': '12209' },
    ]);
  });

  it('renders dotted paths as odata segments', () => {
    expect(toFilter(eq('address.city', 'London'))).toBe("address/city eq 'London'");
    const q = query<Customer>('Customer', where(any('phones', eq('kind', 'fax'))), pick('address.zip'));
    expect(decodeURIComponent(toOData(q))).toBe("Customer?$filter=phones/any(x: x/kind eq 'fax')&$select=address/zip");
  });

  it('runs against the store without touching navigations', () => {
    const s = store(nw);
    s.merge('Customer', rows);
    expect(s.run(query<Customer>('Customer', where(eq('address.zip', 'WA1 1DP')))).map((c) => c.id)).toEqual([3]);
    expect(s.get<Customer>('Customer', 1)?.address).toEqual(berlinAddr);
  });
});

describe('change tracking of complex values', () => {
  it('merges patches into complex properties and tracks the whole previous value', () => {
    const s = store(nw);
    s.attach('Customer', berlin);
    const next = s.patch<Customer>('Customer', 1, { address: { city: 'Bonn' } });
    expect(next.address).toEqual({ ...berlinAddr, city: 'Bonn' });
    const [row] = s.changes();
    expect(row?.state).toBe('changed');
    expect(row?.orig).toEqual({ address: berlinAddr });
    s.patch<Customer>('Customer', 1, { phones: [] });
    expect(s.get<Customer>('Customer', 1)?.phones).toEqual([]);
    s.revert('Customer', 1);
    expect(s.get<Customer>('Customer', 1)).toEqual(berlin);
    expect(s.changes()).toEqual([]);
  });

  it('keeps identity across merges of structurally equal data', () => {
    const s = store(nw);
    const [a] = s.merge('Customer', [structuredClone(berlin)]);
    const [b] = s.merge('Customer', [structuredClone(berlin)]);
    expect(b).toBe(a);
    const [c] = s.merge('Customer', [{ ...structuredClone(berlin), address: { ...berlinAddr, zip: '00000' } }]);
    expect(c).not.toBe(a);
  });

  it('watches without spurious emissions for unchanged nested values', () => {
    const s = store(nw);
    s.merge('Customer', [berlin, london]);
    const seen: string[][] = [];
    const sub = s
      .watch(query<Customer>('Customer', where(eq('address.city', 'Berlin'))))
      .subscribe((cs) => seen.push(cs.map((c) => c.address?.zip ?? '')));
    s.merge('Customer', [structuredClone(berlin)]);
    s.patch<Customer>('Customer', 3, { address: { zip: 'X' } });
    s.patch<Customer>('Customer', 1, { address: { zip: '10115' } });
    sub.unsubscribe();
    expect(seen).toEqual([['12209'], ['10115']]);
  });

  it('survives snapshot and restore', () => {
    const s = store(nw);
    s.attach('Customer', berlin);
    s.patch<Customer>('Customer', 1, { address: { city: 'Bonn' } });
    const s2 = store(nw);
    s2.restore(s.snapshot());
    expect(s2.get<Customer>('Customer', 1)?.address?.city).toBe('Bonn');
    expect(s2.changes()[0]?.orig).toEqual({ address: berlinAddr });
  });
});

describe('validation of complex values', () => {
  const check = validate(nw);

  it('validates nested properties with full paths', () => {
    expect(check('Customer', berlin)).toEqual([]);
    const found = check('Customer', {
      ...berlin,
      address: { street: 's', city: '', zip: 'z' },
      phones: [
        { kind: 'work', number: '1' },
        { kind: 'home', number: '' },
      ],
    });
    expect(found.map((i) => `${i.path}:${i.rule}`)).toEqual(['address.city:required', 'phones.1.number:required']);
    expect(found[0]?.message).toBe('address.city is required');
    expect(found[0]?.key).toBe(1);
    expect(found[0]?.type).toBe('Customer');
  });

  it('checks the shape of complex values', () => {
    const found = check('Customer', { ...berlin, address: 'nope', phones: {} });
    expect(found.map((i) => i.message)).toEqual(['address must be an Address', 'phones must be a list of Phone']);
  });

  it('narrows to nested paths with only', () => {
    const bad = { ...berlin, name: '', address: { street: 's', city: '', zip: 'z' } };
    expect(check('Customer', bad, ['address.city']).map((i) => i.path)).toEqual(['address.city']);
    expect(check('Customer', bad, ['address']).map((i) => i.path)).toEqual(['address.city']);
    expect(check('Customer', bad, ['name']).map((i) => i.path)).toEqual(['name']);
    expect(check('Customer', bad).map((i) => i.path)).toEqual(['name', 'address.city']);
  });
});
