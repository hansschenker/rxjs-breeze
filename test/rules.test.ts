import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { client } from '../src/provider';
import { memory } from '../src/providers/memory';
import { query } from '../src/query';
import { email, int, max, maxLen, min, ofKind, pattern, range, required, url } from '../src/rules';
import { store } from '../src/store';
import { isInvalid, validate } from '../src/validate';
import { alfreds, customers, nw, o10, type Customer } from './fixtures';

const ctx = { type: 'T', path: 'x', entity: {} };

describe('rules', () => {
  it('required rejects null, undefined and empty strings', () => {
    expect(required().check(null, ctx)).toBe('x is required');
    expect(required().check(undefined, ctx)).toBe('x is required');
    expect(required().check('', ctx)).toBe('x is required');
    expect(required().check(0, ctx)).toBeNull();
    expect(required(true).check('', ctx)).toBeNull();
  });

  it('length and range rules ignore nulls', () => {
    expect(maxLen(3).check('abcd', ctx)).toBe('x must be at most 3 characters');
    expect(maxLen(3).check(null, ctx)).toBeNull();
    expect(min(0).check(-1, ctx)).toBe('x must be at least 0');
    expect(min(0).check(0, ctx)).toBeNull();
    expect(max(new Date('2024-01-01T00:00:00.000Z')).check(new Date('2024-06-01'), ctx)).toBe(
      'x must be at most 2024-01-01T00:00:00.000Z',
    );
    expect(range(1, 5).check(3, ctx)).toBeNull();
    expect(range(1, 5).check(6, ctx)).toBe('x must be between 1 and 5');
    expect(int().check(1.5, ctx)).toBe('x must be a whole number');
    expect(int().check(2, ctx)).toBeNull();
  });

  it('pattern rules skip empty strings and carry their own names', () => {
    expect(email().check('a@b.co', ctx)).toBeNull();
    expect(email().check('nope', ctx)).toBe('x is not a valid email address');
    expect(email().check('', ctx)).toBeNull();
    expect(email().name).toBe('email');
    expect(url().check('https://x.y/z', ctx)).toBeNull();
    expect(url().check('x.y', ctx)).toBe('x is not a valid URL');
    expect(pattern(/^\d+$/, 'number string').check('12a', ctx)).toBe('x is not a valid number string');
  });

  it('kind rules follow schema kinds', () => {
    expect(ofKind('date').check(new Date('nope'), ctx)).toBe('x must be a date');
    expect(ofKind('number').check('1', ctx)).toBe('x must be a number');
    expect(ofKind('boolean').check(true, ctx)).toBeNull();
    expect(ofKind('number').check(undefined, ctx)).toBeNull();
  });
});

describe('validate', () => {
  const check = validate(nw);

  it('runs kind checks, property rules and entity checks', () => {
    expect(check('Customer', alfreds)).toEqual([]);
    const bad = check('Customer', { id: 'one', name: '', city: 'x'.repeat(5) });
    expect(bad.map((i) => `${i.path}:${i.rule}`)).toEqual(['id:kind', 'name:required']);
    expect(bad[0]?.key).toBe('one');
    const future = check('Order', { ...o10, placed: new Date(Date.now() + 1e9) });
    expect(future.map((i) => i.rule)).toEqual(['not-future']);
    expect(future[0]?.path).toBeNull();
    expect(future[0]?.message).toBe('placed cannot be in the future');
  });

  it('can check selected properties only', () => {
    expect(check('Customer', { id: 1, name: '', city: '' }, ['city']).map((i) => i.path)).toEqual(['city']);
  });
});

describe('store issues', () => {
  it('reports issues for pending rows only, and streams them', () => {
    const s = store(nw);
    s.merge('Customer', customers);
    const seen: number[] = [];
    const sub = s.issues$.subscribe((found) => seen.push(found.length));
    s.patch<Customer>('Customer', 1, { name: '' });
    expect(s.issues().map((i) => i.message)).toEqual(['name is required']);
    expect(s.issues('Customer', 1)[0]?.rule).toBe('required');
    expect(s.issues('Customer', 2)).toEqual([]);
    s.patch<Customer>('Customer', 2, { city: 'Paris' });
    s.revert('Customer', 1);
    sub.unsubscribe();
    expect(seen).toEqual([0, 1, 0]);
  });

  it('ignores removed rows', () => {
    const s = store(nw);
    s.attach('Customer', { ...alfreds, name: '' });
    s.remove('Customer', 1);
    expect(s.issues()).toEqual([]);
  });
});

describe('save validation', () => {
  it('refuses to save invalid rows unless told otherwise', async () => {
    const db = client(store(nw), memory(nw, { Customer: customers }));
    await firstValueFrom(db.fetch(query<Customer>('Customer')));
    db.store.patch<Customer>('Customer', 1, { name: '' });
    const err: unknown = await firstValueFrom(db.save()).catch((e: unknown) => e);
    expect(isInvalid(err)).toBe(true);
    expect(isInvalid(err) ? err.issues[0]?.rule : null).toBe('required');
    expect(isInvalid(err) ? err.message : '').toContain('name is required');
    expect(db.store.changes().length).toBe(1);
    await firstValueFrom(db.save(undefined, { validate: false }));
    expect(db.store.changes()).toEqual([]);
  });
});
