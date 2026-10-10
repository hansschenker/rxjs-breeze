import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { eq } from '../src/pred';
import { client } from '../src/provider';
import { http } from '../src/providers/http';
import { memory } from '../src/providers/memory';
import { count, expand, order, query, take, where } from '../src/query';
import { store } from '../src/store';
import { customers, lines, nw, orders, type Customer, type Order } from './fixtures';

const seed = () => memory(nw, { Customer: customers, Order: orders, Line: lines });

describe('client with memory provider', () => {
  it('fetches remotely, normalizes and fills navigations', async () => {
    const db = client(store(nw), seed());
    const rows = await firstValueFrom(
      db.fetch(query<Order>('Order', where(eq('customerId', 1)), expand('customer'))),
    );
    expect(rows.map((o) => o.id)).toEqual([10, 11]);
    expect(rows[0]?.customer?.name).toBe('Alfreds Futterkiste');
    expect(db.store.get<Customer>('Customer', 1)?.name).toBe('Alfreds Futterkiste');
    expect(db.store.get<Order>('Order', 10)).not.toHaveProperty('customer');
  });

  it('filters on navigation paths remotely', async () => {
    const db = client(store(nw), seed());
    const rows = await firstValueFrom(db.fetch(query<Order>('Order', where(eq('customer.city', 'London')))));
    expect(rows.map((o) => o.id)).toEqual([12]);
  });

  it('honours fetch sources and merge strategies', async () => {
    const db = client(store(nw), seed());
    const q = query<Customer>('Customer');
    expect(await firstValueFrom(db.fetch(q, { from: 'local' }))).toEqual([]);
    expect((await firstValueFrom(db.fetch(q, { from: 'localFirst' }))).length).toBe(3);
    db.store.patch<Customer>('Customer', 1, { name: 'Local edit' });
    expect((await firstValueFrom(db.fetch(q, { from: 'localFirst' })))[0]?.name).toBe('Local edit');
    expect((await firstValueFrom(db.fetch(q)))[0]?.name).toBe('Local edit');
    expect((await firstValueFrom(db.fetch(q, { merge: 'overwrite' })))[0]?.name).toBe('Alfreds Futterkiste');
    expect(db.store.changes()).toEqual([]);
  });

  it('pages with a total count', async () => {
    const db = client(store(nw), seed());
    const p = await firstValueFrom(db.page(query<Order>('Order', order('total'), take(2), count())));
    expect(p.count).toBe(3);
    expect(p.rows.map((o) => o.id)).toEqual([12, 10]);
  });

  it('saves a change set, assigns real keys and fixes foreign keys', async () => {
    const mem = seed();
    const db = client(store(nw), mem);
    const c = db.store.add<{ id?: number; name: string; city: string }>('Customer', {
      name: 'Bottom-Dollar Markets',
      city: 'Tsawassen',
    });
    db.store.add<{ id?: number; customerId: number; total: number; placed: Date }>('Order', {
      customerId: c.id ?? 0,
      total: 42,
      placed: new Date(),
    });
    await firstValueFrom(db.fetch(query<Order>('Order')));
    db.store.patch<Order>('Order', 12, { total: 80 });
    db.store.remove('Order', 11);
    expect(db.store.changes().length).toBe(4);

    const saved = await firstValueFrom(db.save());
    expect(saved.removed?.length).toBe(1);
    expect(db.store.changes()).toEqual([]);

    const [newC] = db.store.run(query<Customer>('Customer', where(eq('name', 'Bottom-Dollar Markets'))));
    expect(newC?.id).toBeGreaterThan(0);
    const [newO] = db.store.run(query<Order>('Order', where(eq('total', 42))));
    expect(newO?.id).toBeGreaterThan(0);
    expect(newO?.customerId).toBe(newC?.id);
    expect(db.store.get('Order', 11)).toBeUndefined();
    expect(mem.rows<Order>('Order').find((o) => o.id === 12)?.total).toBe(80);
    expect(mem.rows('Order').length).toBe(3);
  });

  it('saving nothing is a no-op', async () => {
    const db = client(store(nw), seed());
    expect(await firstValueFrom(db.save())).toEqual({ rows: [] });
  });
});

describe('http provider', () => {
  it('translates queries to odata urls and parses odata bodies', async () => {
    const calls: string[] = [];
    const fake: typeof fetch = async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return new Response(JSON.stringify({ value: [{ id: 1, name: 'A', city: 'B' }], '@odata.count': 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const db = client(store(nw), http('https://api.test/odata/', { fetch: fake }));
    const p = await firstValueFrom(db.page(query<Customer>('Customer', where(eq('city', 'B')), count())));
    expect(p.count).toBe(1);
    expect(p.rows[0]?.name).toBe('A');
    expect(calls).toEqual(["GET https://api.test/odata/Customer?$filter=city%20eq%20'B'&$count=true"]);
  });

  it('posts change sets and surfaces http errors', async () => {
    const fake: typeof fetch = async (input, init) =>
      String(input).endsWith('/save')
        ? new Response(JSON.stringify({ rows: [{ type: 'Customer', data: { id: 7, name: 'N', city: 'C' }, was: -1 }] }), {
            status: 200,
          })
        : new Response('nope', { status: 500, statusText: 'Boom' });
    const db = client(store(nw), http('https://api.test', { fetch: fake }));
    db.store.add<{ id?: number; name: string; city: string }>('Customer', { name: 'N', city: 'C' });
    await firstValueFrom(db.save());
    expect(db.store.get<Customer>('Customer', 7)?.name).toBe('N');
    expect(db.store.changes()).toEqual([]);
    await expect(firstValueFrom(db.fetch(query<Customer>('Customer')))).rejects.toThrow('500 Boom');
  });
});
