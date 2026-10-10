/**
 * The reference JSON server: any `Provider` served over HTTP in the wire
 * format the `http` client provider speaks with `url: toJsonUrl`.
 *
 *   GET  {base}/{Type}?q={toJson(query)}   -> { rows, count? }
 *   GET  {base}/{Type}                     -> every row of Type
 *   POST {base}/query   body: query JSON   -> { rows, count? }
 *   POST {base}/save    body: { rows }     -> { rows: [{ type, data, was? }], removed: [{ type, key }] }
 *
 * Dates travel as ISO strings and are revived on both sides. Errors come
 * back as `{ error: { message } }`. Node only: import from 'rxjs-breeze/server'.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { firstValueFrom, tap } from 'rxjs';
import type { Row } from './cache';
import { fromJson, revive } from './interp/json';
import type { Provider } from './provider';
import type { Memory } from './providers/memory';
import { query } from './query';
import { type Schema, isComplex } from './schema';

export interface Req {
  readonly method: string;
  readonly url: string;
  readonly body?: string;
}

export interface Res {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface HandleOpts {
  /** Path prefix the routes live under, e.g. "/api". */
  readonly base?: string;
  /** Allowed CORS origin; `false` sends no CORS headers. Default "*". */
  readonly cors?: string | false;
}

export interface ServeOpts extends HandleOpts {
  /** 0 (the default) picks a free port. */
  readonly port?: number;
  readonly host?: string;
}

export interface Running {
  readonly url: string;
  readonly port: number;
  readonly close: () => Promise<void>;
}

const isRow = (x: unknown): x is Row =>
  typeof x === 'object' && x !== null && 'type' in x && 'key' in x && 'data' in x && 'state' in x;

/** A framework-free request handler over a provider. `serve` wraps it in node:http. */
export const handle = (provider: Provider, opts: HandleOpts = {}): ((req: Req) => Promise<Res>) => {
  const base = (opts.base ?? '').replace(/\/+$/, '');
  const cors: Readonly<Record<string, string>> =
    opts.cors === false
      ? {}
      : {
          'access-control-allow-origin': opts.cors ?? '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type, accept, prefer',
        };
  const reply = (status: number, body: unknown): Res => ({
    status,
    headers: { ...cors, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const fail = (status: number, message: string): Res => reply(status, { error: { message } });

  return async (req: Req): Promise<Res> => {
    const u = new URL(req.url, 'http://local');
    if (base && !u.pathname.startsWith(base)) return fail(404, `not under ${base}`);
    const path = u.pathname.slice(base.length).replace(/\/+$/, '') || '/';
    const method = req.method.toUpperCase();
    if (method === 'OPTIONS') return { status: 204, headers: cors, body: '' };
    try {
      if (method === 'GET') {
        const q = u.searchParams.get('q');
        const type = path.slice(1);
        if (!q && !type) return fail(404, 'expected /Type or ?q=');
        return reply(200, await firstValueFrom(provider.query(q ? fromJson<object>(q) : query<object>(type))));
      }
      if (method === 'POST' && path === '/query') {
        return reply(200, await firstValueFrom(provider.query(fromJson<object>(req.body ?? ''))));
      }
      if (method === 'POST' && path === '/save') {
        const raw: unknown = JSON.parse(req.body ?? '', revive);
        const rows =
          raw !== null && typeof raw === 'object' && Array.isArray((raw as { rows?: unknown }).rows)
            ? (raw as { rows: unknown[] }).rows
            : null;
        if (!rows || !rows.every(isRow)) return fail(400, 'expected { rows: Row[] }');
        return reply(200, await firstValueFrom(provider.save(rows)));
      }
      return fail(404, `no route for ${method} ${path}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return fail(e instanceof SyntaxError || message.startsWith('rxjs-breeze:') ? 400 : 500, message);
    }
  };
};

/** Serve a provider with node:http. Resolves once listening. */
export const serve = (provider: Provider, opts: ServeOpts = {}): Promise<Running> =>
  new Promise((resolve, reject) => {
    const h = handle(provider, opts);
    const host = opts.host ?? '127.0.0.1';
    const server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
      });
      req.on('end', () => {
        h({ method: req.method ?? 'GET', url: req.url ?? '/', body }).then(
          (r) => {
            res.writeHead(r.status, r.headers);
            res.end(r.body);
          },
          (e: unknown) => {
            res.writeHead(500);
            res.end(String(e));
          },
        );
      });
    });
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      const a = server.address();
      const port = a !== null && typeof a === 'object' ? a.port : (opts.port ?? 0);
      resolve({
        url: `http://${host}:${port}${(opts.base ?? '').replace(/\/+$/, '')}`,
        port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });

/** Read a seed written by `persist`; undefined when the file does not exist yet. */
export const load = (file: string): Record<string, object[]> | undefined => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'), revive) as Record<string, object[]>;
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return undefined;
    throw e;
  }
};

/** Wrap a memory provider so every successful save rewrites `file` with all entity rows. */
export const persist = (file: string, mem: Memory, s: Schema): Provider => {
  const write = (): void => {
    const types = Object.keys(s).filter((t) => !isComplex(s, t));
    writeFileSync(file, JSON.stringify(Object.fromEntries(types.map((t) => [t, mem.rows(t)]))));
  };
  return { query: mem.query, save: (rows) => mem.save(rows).pipe(tap(write)) };
};
