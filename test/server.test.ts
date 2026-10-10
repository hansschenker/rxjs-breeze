import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { toJson, toJsonUrl } from '../src/interp/json';
import { eq } from '../src/pred';
import { client } from '../src/provider';
import { http } from '../src/providers/http';
import { memory } from '../src/providers/memory';
import { count, expand, order, query, where } from '../src/query';
import { handle, load, persist, serve } from '../src/server';
import { store } from '../src/store';
import { customers, lines, nw, orders, type Customer, type Order } from './fixtures';

const seed = () => ({ Customer: customers, Order: orders, Line: lines });
const json = (res: { body: string }): Record<string, unknown> => JSON.parse(res.body) as Record<string, unknown>;

describe('handle', () => {
  const h = handle(memory(nw, seed()), { base: '/api' });

  it('answers GET with a query in q, including the count', async () => {
    const q = query<Customer>('Customer', where(eq('city', 'Berlin')), count());
    const res = await h({ method: 'GET', url: `/api/Customer?q=${encodeURIComponent(toJson(q))}` });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    const page = json(res) as { rows: Customer[]; count: number };
    expect(page.rows.map((c) => c.id)).toEqual([1]);
    expect(page.count).toBe(1);
  });

  it('answers GET /Type with everything and POST /query with a body', async () => {
    const all = json(await h({ method: 'GET', url: '/api/Customer' })) as { rows: Customer[] };
    expect(all.rows.length).toBe(3);
    const q = query<Order>('Order', order('total', 'desc'));
    const posted = json(await h({ method: 'POST', url: '/api/query', body: toJson(q) })) as { rows: Order[] };
    expect(posted.rows.map((o) => o.id)).toEqual([11, 10, 12]);
  });

  it('saves a change set and reports new keys', async () => {
    const rows = [
      { type: 'Customer', key: -1, data: { id: -1, name: 'New', city: 'Oslo' }, state: 'added', orig: null },
      { type: 'Order', key: 12, data: { ...orders[2], total: 1 }, state: 'changed', orig: { total: 75 } },
    ];
    const res = await h({ method: 'POST', url: '/api/save', body: JSON.stringify({ rows }) });
    expect(res.status).toBe(200);
    const saved = json(res) as { rows: { type: string; data: { id: number }; was?: number }[] };
    expect(saved.rows[0]?.was).toBe(-1);
    expect(saved.rows[0]?.data.id).toBeGreaterThan(0);
  });

  it('answers preflight, bad input and unknown routes', async () => {
    const pre = await h({ method: 'OPTIONS', url: '/api/save' });
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-methods']).toContain('POST');
    expect((await h({ method: 'GET', url: '/api/Customer?q=%7B%22nope%22%3A1%7D' })).status).toBe(400);
    expect((await h({ method: 'GET', url: '/api/Nope' })).status).toBe(400);
    expect((await h({ method: 'POST', url: '/api/save', body: '{"rows":[1]}' })).status).toBe(400);
    expect((await h({ method: 'POST', url: '/api/save', body: 'not json' })).status).toBe(400);
    expect((await h({ method: 'GET', url: '/elsewhere' })).status).toBe(404);
    expect((await h({ method: 'DELETE', url: '/api/Customer' })).status).toBe(404);
    expect(json(await h({ method: 'GET', url: '/api/Nope' }))).toEqual({ error: { message: 'rxjs-breeze: unknown type "Nope"' } });
  });

  it('can run without CORS headers', async () => {
    const quiet = handle(memory(nw, seed()), { cors: false });
    const res = await quiet({ method: 'GET', url: '/Customer' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('serve', () => {
  it('serves the http client provider end to end over a socket', async () => {
    const running = await serve(memory(nw, seed()));
    try {
      const connect = () => client(store(nw), http(running.url, { url: toJsonUrl }));
      const db = connect();
      const rows = await firstValueFrom(
        db.fetch(query<Order>('Order', where(eq('customerId', 1)), expand('customer'), order('id'))),
      );
      expect(rows.map((o) => o.id)).toEqual([10, 11]);
      expect(rows[0]?.placed).toBeInstanceOf(Date);
      expect(rows[0]?.customer?.name).toBe('Alfreds Futterkiste');

      db.store.patch<Order>('Order', 10, { total: 1 });
      db.store.add<{ id?: number; name: string; city: string }>('Customer', { name: 'New', city: 'Oslo' });
      db.store.remove('Order', 11);
      const saved = await firstValueFrom(db.save());
      expect(saved.rows.find((r) => r.was !== undefined)?.was).toBe(-1);
      expect(saved.removed?.length).toBe(1);
      expect(db.store.changes()).toEqual([]);

      const fresh = await firstValueFrom(connect().fetch(query<Order>('Order', order('id'))));
      expect(fresh.map((o) => `${o.id}:${o.total}`)).toEqual(['10:1', '12:75']);
      const page = await firstValueFrom(connect().page(query<Customer>('Customer', count())));
      expect(page.count).toBe(4);
    } finally {
      await running.close();
    }
  });

  it('persists memory data to a file and loads it back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rxjs-breeze-'));
    const file = join(dir, 'data.json');
    try {
      expect(load(file)).toBeUndefined();
      const mem = memory(nw, seed());
      const running = await serve(persist(file, mem, nw));
      try {
        const db = client(store(nw), http(running.url, { url: toJsonUrl }));
        await firstValueFrom(db.fetch(query<Customer>('Customer')));
        db.store.patch<Customer>('Customer', 2, { city: 'Lima' });
        await firstValueFrom(db.save());
      } finally {
        await running.close();
      }
      const data = load(file);
      expect(Object.keys(data ?? {}).sort()).toEqual(['Customer', 'Line', 'Order']);
      expect((data?.['Customer'] as Customer[]).find((c) => c.id === 2)?.city).toBe('Lima');
      expect((data?.['Order'] as Order[])[0]?.placed).toBeInstanceOf(Date);
      expect(memory(nw, data).rows<Customer>('Customer').length).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
