import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { toJsonUrl } from '../src/interp/json';
import { toOData } from '../src/interp/odata';
import { camel, naming, renameData, renameQuery, same, snake } from '../src/naming';
import { any, eq, gt } from '../src/pred';
import { client } from '../src/provider';
import { http } from '../src/providers/http';
import { memory } from '../src/providers/memory';
import { odata } from '../src/providers/odata';
import { expand, order, pick, query, where } from '../src/query';
import { serve } from '../src/server';
import { store } from '../src/store';
import { customers, lines, nw, orders, type Customer, type Order } from './fixtures';

describe('conventions', () => {
  it('camel, snake, same and custom pairs', () => {
    expect(camel.toServer('companyName')).toBe('CompanyName');
    expect(camel.toClient('CompanyName')).toBe('companyName');
    expect(snake.toServer('shipToCity')).toBe('ship_to_city');
    expect(snake.toClient('ship_to_city')).toBe('shipToCity');
    expect(same.toServer('x')).toBe('x');
    const upper = naming(
      (n) => n.toUpperCase(),
      (n) => n.toLowerCase(),
    );
    expect(upper.toClient(upper.toServer('name'))).toBe('name');
  });

  it('renames every path in a query but not the type', () => {
    const q = query<Order>(
      'Order',
      where(gt('total', 5), any('lines', eq('qty', 1))),
      order('customer.city'),
      pick('id', 'customer.name'),
      expand('customer.orders'),
    );
    const r = renameQuery(camel.toServer)(q);
    expect(r.type).toBe('Order');
    expect(decodeURIComponent(toOData(r))).toBe(
      'Order?$filter=(Total gt 5 and Lines/any(x: x/Qty eq 1))&$orderby=Customer/City&$expand=Customer/Orders&$select=Id,Customer/Name',
    );
    expect(renameQuery(camel.toClient)(r)).toEqual(q);
  });

  it('renames data keys deeply, leaving dates, arrays and annotations alone', () => {
    const d = new Date();
    expect(
      renameData(camel.toServer)({
        id: 1,
        placed: d,
        '@odata.etag': 'x',
        'customer@odata.bind': '$1',
        lines: [{ qty: 2 }],
        address: { zip: '1' },
      }),
    ).toEqual({ Id: 1, Placed: d, '@odata.etag': 'x', 'customer@odata.bind': '$1', Lines: [{ Qty: 2 }], Address: { Zip: '1' } });
  });
});

describe('http provider with a naming convention', () => {
  it('renames queries, bodies and responses', async () => {
    const calls: string[] = [];
    const fake: typeof fetch = async (input, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      calls.push(`${init?.method ?? 'GET'} ${decodeURIComponent(String(input))}${body ? ` ${body}` : ''}`);
      return String(input).endsWith('/save')
        ? new Response(JSON.stringify({ rows: [{ type: 'Customer', data: { Id: 7, Name: 'N', City: 'C' }, was: -1 }] }))
        : new Response(JSON.stringify({ value: [{ Id: 1, Name: 'A', City: 'B' }] }));
    };
    const db = client(store(nw), http('https://api.test', { fetch: fake, naming: camel }));
    const rows = await firstValueFrom(db.fetch(query<Customer>('Customer', where(eq('city', 'B')), order('name'))));
    expect(rows).toEqual([{ id: 1, name: 'A', city: 'B' }]);
    db.store.add<{ id?: number; name: string; city: string }>('Customer', { name: 'N', city: 'C' });
    await firstValueFrom(db.save());
    expect(db.store.get<Customer>('Customer', 7)).toEqual({ id: 7, name: 'N', city: 'C' });
    expect(calls).toEqual([
      "GET https://api.test/Customer?$filter=City eq 'B'&$orderby=Name",
      'POST https://api.test/save {"rows":[{"type":"Customer","key":-1,"data":{"Name":"N","City":"C","Id":-1},"state":"added","orig":null}]}',
    ]);
  });
});

describe('odata provider with a naming convention', () => {
  it('renames bodies, key paths and responses', async () => {
    const calls: string[] = [];
    let next = 100;
    const fake: typeof fetch = async (input, init) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : '';
      calls.push(`${method} ${String(input).replace('https://api.test/', '')}${body ? ` ${body}` : ''}`);
      if (method === 'POST') {
        return new Response(JSON.stringify({ Id: next++, ...(JSON.parse(body) as object) }), { status: 201 });
      }
      return new Response(null, { status: 204 });
    };
    const sets = { Customer: 'Customers', Order: 'Orders', Line: 'Lines' };
    const db = client(store(nw), odata(nw, 'https://api.test/', { fetch: fake, naming: camel, sets }));
    db.store.merge('Order', orders);
    db.store.merge('Line', lines);
    const c = db.store.add<{ id?: number; name: string; city: string }>('Customer', { name: 'New Co', city: 'Oslo' });
    db.store.add<{ id?: number; customerId: number; total: number; placed: Date }>('Order', {
      customerId: c.id ?? 0,
      total: 5,
      placed: new Date('2024-05-01T00:00:00.000Z'),
    });
    db.store.patch<Order>('Order', 12, { total: 80 });
    db.store.remove('Line', [10, 1]);
    await firstValueFrom(db.save());
    expect(calls).toEqual([
      'POST Customers {"Name":"New Co","City":"Oslo"}',
      'POST Orders {"CustomerId":100,"Total":5,"Placed":"2024-05-01T00:00:00.000Z"}',
      'PATCH Orders(12) {"Total":80}',
      'DELETE Lines(OrderId=10,ProductId=1)',
    ]);
    expect(db.store.get<Customer>('Customer', 100)).toEqual({ id: 100, name: 'New Co', city: 'Oslo' });
    const [created] = db.store.run(query<Order>('Order', where(eq('total', 5))));
    expect(created?.customerId).toBe(100);
    expect(created?.placed).toBeInstanceOf(Date);
  });

  it('binds new parents with server-side navigation names in a batch', async () => {
    let seen: unknown[] = [];
    const fake: typeof fetch = async (_input, init) => {
      const { requests } = JSON.parse(String(init?.body)) as { requests: { id: string; body?: object }[] };
      seen = requests.map((r) => r.body);
      const responses = requests.map((r, i) => ({ id: r.id, status: 201, body: { Id: 100 + i, ...r.body } }));
      return new Response(JSON.stringify({ responses }), { headers: { 'content-type': 'application/json' } });
    };
    const db = client(store(nw), odata(nw, 'https://api.test', { fetch: fake, naming: camel, batch: 'json' }));
    const c = db.store.add<{ id?: number; name: string; city: string }>('Customer', { name: 'N', city: 'C' });
    db.store.add<{ id?: number; customerId: number; total: number; placed: Date }>('Order', {
      customerId: c.id ?? 0,
      total: 1,
      placed: new Date(),
    });
    await firstValueFrom(db.save());
    expect(seen).toEqual([
      { Name: 'N', City: 'C' },
      { Total: 1, Placed: expect.any(String) as string, 'Customer@odata.bind': '$1' },
    ]);
    expect(db.store.changes()).toEqual([]);
    expect(db.store.run(query<Order>('Order'))[0]?.customerId).toBe(100);
  });
});

describe('reference server with a naming convention', () => {
  it('exposes server names on the wire and client names in the store', async () => {
    const running = await serve(memory(nw, { Customer: customers, Order: orders, Line: lines }), { naming: camel });
    try {
      const raw = (await (await fetch(`${running.url}/Customer`)).json()) as { rows: Record<string, unknown>[] };
      expect(Object.keys(raw.rows[0] ?? {})).toEqual(['Id', 'Name', 'City']);

      const connect = () => client(store(nw), http(running.url, { url: toJsonUrl, naming: camel }));
      const db = connect();
      const rows = await firstValueFrom(db.fetch(query<Order>('Order', where(eq('customerId', 1)), order('id'))));
      expect(rows.map((o) => o.id)).toEqual([10, 11]);
      db.store.patch<Order>('Order', 10, { total: 1 });
      await firstValueFrom(db.save());
      expect(db.store.changes()).toEqual([]);
      const again = await firstValueFrom(connect().fetch(query<Order>('Order', where(eq('id', 10)))));
      expect(again[0]?.total).toBe(1);
    } finally {
      await running.close();
    }
  });
});
