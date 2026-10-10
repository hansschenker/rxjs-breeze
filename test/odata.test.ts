import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { eq } from '../src/pred';
import { client } from '../src/provider';
import { odata } from '../src/providers/odata';
import { query, where } from '../src/query';
import { store } from '../src/store';
import { alfreds, lines, nw, orders, type Customer, type Order } from './fixtures';

/** A fake OData server: records requests, assigns ids on POST, answers PATCH/DELETE with 204. */
const server = (opts: { failPatch?: boolean; silentPost?: boolean } = {}) => {
  const calls: string[] = [];
  let nextId = 100;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    const url = String(input).replace('https://api.test/', '');
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push(`${method} ${url}${body ? ` ${body}` : ''}`);
    if (method === 'POST') {
      if (opts.silentPost) return new Response(null, { status: 204 });
      const data = { '@odata.context': 'ctx', id: nextId++, ...(JSON.parse(body) as object) };
      return new Response(JSON.stringify(data), { status: 201 });
    }
    if (method === 'PATCH') return new Response(null, { status: opts.failPatch ? 500 : 204, statusText: 'Boom' });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ value: [{ id: 1, name: 'A', city: 'B' }] }), { status: 200 });
  };
  return { calls, fetch };
};

const sets = { Customer: 'Customers', Order: 'Orders', Line: 'Lines' };
const connect = (srv: ReturnType<typeof server>) =>
  client(store(nw), odata(nw, 'https://api.test/', { fetch: srv.fetch, sets }));

describe('odata provider', () => {
  it('maps types to entity sets for reads', async () => {
    const srv = server();
    const db = connect(srv);
    const rows = await firstValueFrom(db.fetch(query<Customer>('Customer', where(eq('city', 'B')))));
    expect(rows[0]?.name).toBe('A');
    expect(srv.calls).toEqual(["GET Customers?$filter=city%20eq%20'B'"]);
  });

  it('writes a change set as POST, PATCH and DELETE in dependency order', async () => {
    const srv = server();
    const db = connect(srv);
    db.store.merge('Order', orders);
    db.store.merge('Line', lines);
    const c = db.store.add<{ id?: number; name: string; city: string }>('Customer', { name: 'New Co', city: 'Oslo' });
    db.store.add<{ id?: number; customerId: number; total: number; placed: Date }>('Order', {
      customerId: c.id ?? 0,
      total: 5,
      placed: new Date('2024-05-01T00:00:00.000Z'),
    });
    db.store.patch<Order>('Order', 12, { total: 80 });
    db.store.remove('Order', 11);
    db.store.remove('Line', [10, 1]);

    const saved = await firstValueFrom(db.save());

    expect(srv.calls).toEqual([
      'POST Customers {"name":"New Co","city":"Oslo"}',
      'POST Orders {"customerId":100,"total":5,"placed":"2024-05-01T00:00:00.000Z"}',
      'PATCH Orders(12) {"total":80}',
      'DELETE Orders(11)',
      'DELETE Lines(orderId=10,productId=1)',
    ]);
    expect(saved.rows.map((r) => r.was)).toEqual([-1, -2, undefined]);
    expect(saved.removed?.length).toBe(2);
    expect(db.store.changes()).toEqual([]);
    expect(db.store.get<Customer>('Customer', 100)?.name).toBe('New Co');
    const [created] = db.store.run(query<Order>('Order', where(eq('total', 5))));
    expect(created?.id).toBe(101);
    expect(created?.customerId).toBe(100);
    expect(created?.placed).toBeInstanceOf(Date);
    expect(db.store.get<Order>('Order', 12)?.total).toBe(80);
    expect(db.store.get('Order', 11)).toBeUndefined();
    expect(db.store.get('Line', [10, 1])).toBeUndefined();
  });

  it('deletes children before their parents and quotes string keys', async () => {
    const srv = server();
    const db = connect(srv);
    db.store.merge('Customer', [alfreds]);
    db.store.merge('Order', orders);
    db.store.remove('Customer', 1);
    db.store.remove('Order', 10);
    await firstValueFrom(db.save());
    expect(srv.calls).toEqual(['DELETE Orders(10)', 'DELETE Customers(1)']);

    const quoted = odata({ P: { key: 'code', props: { code: 'string' } } }, 'https://api.test', { fetch: srv.fetch });
    const db2 = client(store({ P: { key: 'code', props: { code: 'string' } } }), quoted);
    db2.store.attach('P', { code: "O'Neil" });
    db2.store.remove('P', "O'Neil");
    await firstValueFrom(db2.save());
    expect(srv.calls.at(-1)).toBe("DELETE P('O''Neil')");
  });

  it('fails the save and leaves the store dirty when a request fails', async () => {
    const srv = server({ failPatch: true });
    const db = connect(srv);
    db.store.merge('Order', orders);
    db.store.patch<Order>('Order', 12, { total: 80 });
    await expect(firstValueFrom(db.save())).rejects.toThrow(/PATCH .*Orders\(12\) failed: 500 Boom/);
    expect(db.store.changes().length).toBe(1);
  });

  it('requires the created entity back from a POST', async () => {
    const db = connect(server({ silentPost: true }));
    db.store.add<{ id?: number; name: string; city: string }>('Customer', { name: 'X', city: 'Y' });
    await expect(firstValueFrom(db.save())).rejects.toThrow(/Prefer: return=representation/);
  });
});
