import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { client } from '../src/provider';
import { buildJson, buildMultipart, parseJson, parseMultipart } from '../src/providers/batch';
import { odata } from '../src/providers/odata';
import { schema } from '../src/schema';
import { store } from '../src/store';
import { lines, nw, orders, type Customer, type Order } from './fixtures';

const CRLF = '\r\n';

interface Sub {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

/** A fake OData server that understands `$batch` in both formats and records the sub-requests. */
const server = (opts: { failPatch?: boolean } = {}) => {
  const calls: string[] = [];
  const subs: string[] = [];
  let nextId = 100;

  const handle = (m: Sub): { status: number; text: string; body?: object } => {
    subs.push(`${m.method} ${m.url}${m.body ? ` ${m.body}` : ''}`);
    if (opts.failPatch && m.method === 'PATCH') {
      return { status: 400, text: 'Bad Request', body: { error: { message: 'nope' } } };
    }
    if (m.method === 'POST') {
      const sent = JSON.parse(m.body) as Record<string, unknown>;
      const data = Object.fromEntries(Object.entries(sent).filter(([k]) => !k.endsWith('@odata.bind')));
      return { status: 201, text: 'Created', body: { '@odata.context': 'ctx', id: nextId++, ...data } };
    }
    return { status: 204, text: 'No Content' };
  };

  const strip = (u: string): string => u.replace('https://api.test/', '');

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = strip(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = String(init?.body ?? '');
    calls.push(`${init?.method ?? 'GET'} ${url} [${headers['content-type']?.split(';')[0] ?? ''}]`);
    if (url !== '$batch') return new Response(JSON.stringify({ value: [] }), { status: 200 });

    if (headers['content-type'] === 'application/json') {
      const { requests } = JSON.parse(body) as {
        requests: { id: string; method: string; url: string; body?: object }[];
      };
      const responses = requests
        .map((q) => {
          const r = handle({ id: q.id, method: q.method, url: strip(q.url), body: q.body ? JSON.stringify(q.body) : '' });
          return { id: q.id, status: r.status, ...(r.body ? { body: r.body } : {}) };
        })
        .reverse();
      return new Response(JSON.stringify({ responses }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const cs = /boundary=(changeset_[^\r\n;]+)/.exec(body)?.[1] ?? '';
    const parts = body
      .split(`--${cs}`)
      .slice(1)
      .filter((p) => !p.startsWith('--'));
    const results = parts.map((p) => {
      const [mime = '', http = '', ...rest] = p.split(CRLF + CRLF);
      const id = /Content-ID: (\d+)/.exec(mime)?.[1] ?? '';
      const [, method = '', target = ''] = /^(POST|PATCH|DELETE) (\S+) HTTP\/1\.1/m.exec(http) ?? [];
      return { id, ...handle({ id, method, url: strip(target), body: rest.join(CRLF + CRLF).trim() }) };
    });
    const failed = results.find((r) => r.status >= 400);
    const inner = failed ? [failed] : results;
    const res = inner.map((r) =>
      [
        '--changesetresponse_1',
        'Content-Type: application/http',
        'Content-Transfer-Encoding: binary',
        ...(failed ? [] : [`Content-ID: ${r.id}`]),
        '',
        `HTTP/1.1 ${r.status} ${r.text}`,
        ...(r.body ? ['Content-Type: application/json; odata.metadata=minimal', '', JSON.stringify(r.body)] : ['', '']),
      ].join(CRLF),
    );
    const text = [
      '--batchresponse_1',
      'Content-Type: multipart/mixed; boundary=changesetresponse_1',
      '',
      ...res,
      '--changesetresponse_1--',
      '--batchresponse_1--',
      '',
    ].join(CRLF);
    return new Response(text, {
      status: 200,
      headers: { 'content-type': 'multipart/mixed; boundary=batchresponse_1' },
    });
  };
  return { calls, subs, fetch };
};

const sets = { Customer: 'Customers', Order: 'Orders', Line: 'Lines' };

const scenario = (db: ReturnType<typeof client>) => {
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
};

const expectedSubs = [
  'POST Customers {"name":"New Co","city":"Oslo"}',
  'POST Orders {"total":5,"placed":"2024-05-01T00:00:00.000Z","customer@odata.bind":"$1"}',
  'PATCH Orders(12) {"total":80}',
  'DELETE Orders(11)',
  'DELETE Lines(orderId=10,productId=1)',
];

const expectStoreSaved = (db: ReturnType<typeof client>) => {
  expect(db.store.changes()).toEqual([]);
  expect(db.store.get<Customer>('Customer', 100)?.name).toBe('New Co');
  const created = db.store.run(query<Order>('Order', where(eq('total', 5))))[0];
  expect(created?.id).toBe(101);
  expect(created?.customerId).toBe(100);
  expect(db.store.get<Order>('Order', 12)?.total).toBe(80);
  expect(db.store.get('Order', 11)).toBeUndefined();
  expect(db.store.get('Line', [10, 1])).toBeUndefined();
};

import { eq } from '../src/pred';
import { query, where } from '../src/query';

describe('$batch payloads', () => {
  it('builds and parses multipart bodies', () => {
    const { contentType, body } = buildMultipart([
      { id: '1', method: 'POST', url: 'https://x/Customers', headers: { 'content-type': 'application/json' }, body: { a: 1 } },
      { id: '2', method: 'DELETE', url: 'https://x/Customers(1)', headers: {} },
    ]);
    expect(contentType).toMatch(/^multipart\/mixed; boundary=batch_/);
    expect(body).toContain(
      'Content-ID: 1\r\n\r\nPOST https://x/Customers HTTP/1.1\r\ncontent-type: application/json\r\n\r\n{"a":1}\r\n--changeset_',
    );
    expect(body).toContain('Content-ID: 2\r\n\r\nDELETE https://x/Customers(1) HTTP/1.1\r\n\r\n\r\n--changeset_');

    const text = [
      '--b',
      'Content-Type: multipart/mixed; boundary=c',
      '',
      '--c',
      'Content-Type: application/http',
      '',
      'HTTP/1.1 201 Created',
      'Content-ID: 1',
      'Content-Type: application/json',
      '',
      '{"id":5}',
      '--c',
      'Content-Type: application/http',
      '',
      'HTTP/1.1 204 No Content',
      '',
      '',
      '--c--',
      '--b--',
      '',
    ].join(CRLF);
    expect(parseMultipart(text, 'multipart/mixed; boundary=b')).toEqual([
      { id: '1', status: 201, statusText: 'Created', body: '{"id":5}' },
      { id: undefined, status: 204, statusText: 'No Content', body: '' },
    ]);
  });

  it('builds and parses json batches', () => {
    const { body } = buildJson([
      { id: '1', method: 'POST', url: 'u', headers: {}, body: { a: 1 } },
      { id: '2', method: 'POST', url: 'v', headers: {}, body: { b: '$1' }, dependsOn: ['1'] },
    ]);
    expect(JSON.parse(body)).toEqual({
      requests: [
        { id: '1', method: 'POST', url: 'u', headers: {}, body: { a: 1 }, atomicityGroup: 'g1' },
        { id: '2', method: 'POST', url: 'v', headers: {}, body: { b: '$1' }, atomicityGroup: 'g1', dependsOn: ['1'] },
      ],
    });
    expect(parseJson('{"responses":[{"id":"2","status":204},{"id":"1","status":201,"body":{"id":9}}]}')).toEqual([
      { id: '2', status: 204, statusText: '', body: '' },
      { id: '1', status: 201, statusText: '', body: '{"id":9}' },
    ]);
  });
});

describe('odata provider with $batch', () => {
  it('sends one multipart changeset and binds new parents by Content-ID', async () => {
    const srv = server();
    const db = client(store(nw), odata(nw, 'https://api.test/', { fetch: srv.fetch, sets, batch: 'multipart' }));
    scenario(db);
    const saved = await firstValueFrom(db.save());
    expect(srv.calls).toEqual(['POST $batch [multipart/mixed]']);
    expect(srv.subs).toEqual(expectedSubs);
    expect(saved.rows.map((r) => r.was)).toEqual([-1, -2, undefined]);
    expectStoreSaved(db);
  });

  it('sends one json batch and matches responses by id', async () => {
    const srv = server();
    const db = client(store(nw), odata(nw, 'https://api.test/', { fetch: srv.fetch, sets, batch: 'json' }));
    scenario(db);
    await firstValueFrom(db.save());
    expect(srv.calls).toEqual(['POST $batch [application/json]']);
    expect(srv.subs).toEqual(expectedSubs);
    expectStoreSaved(db);
  });

  it('turns a failed changeset into one error and leaves the store dirty', async () => {
    const srv = server({ failPatch: true });
    const db = client(store(nw), odata(nw, 'https://api.test/', { fetch: srv.fetch, sets, batch: 'multipart' }));
    scenario(db);
    await expect(firstValueFrom(db.save())).rejects.toThrow(/\$batch failed: 400 Bad Request .*nope/);
    expect(db.store.changes().length).toBe(5);
  });

  it('needs a navigation to bind a child to a new parent', async () => {
    const s = schema({
      A: { key: 'id', props: { id: 'number' }, navs: { bs: { to: 'B', fk: 'aId', many: true } } },
      B: { key: 'id', props: { id: 'number', aId: 'number' } },
    });
    const srv = server();
    const db = client(store(s), odata(s, 'https://api.test/', { fetch: srv.fetch, batch: 'multipart' }));
    const a = db.store.add<{ id?: number }>('A', {});
    db.store.add<{ id?: number; aId: number }>('B', { aId: a.id ?? 0 });
    await expect(firstValueFrom(db.save())).rejects.toThrow(/declare a navigation/);
  });
});
