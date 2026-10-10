import { defer, from, map, type Observable } from 'rxjs';
import type { Row, Saved } from '../cache';
import { toOData } from '../interp/odata';
import type { Page, Provider } from '../provider';
import type { Query } from '../query';

export interface HttpOpts {
  /** Query-to-URL translation, relative to `base`. Defaults to OData v4 (`toOData`). */
  readonly url?: (q: Query) => string;
  /** Path of the save endpoint, relative to `base`. Defaults to "save". */
  readonly savePath?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Fetch implementation; defaults to the global one. */
  readonly fetch?: typeof globalThis.fetch;
}

const body = async (res: Response): Promise<unknown> => {
  if (!res.ok) throw new Error(`rxjs-breeze: ${res.status} ${res.statusText}`);
  return res.json();
};

const list = (o: Record<string, unknown>): unknown[] => {
  for (const k of ['value', 'rows', 'results', 'items']) {
    const v = o[k];
    if (Array.isArray(v)) return v as unknown[];
  }
  return [];
};

/** Accepts a bare array, an OData body (`value` + `@odata.count`), or `{ rows, count }`. */
export const toPage = <T extends object>(raw: unknown): Page<T> => {
  if (Array.isArray(raw)) return { rows: raw as T[] };
  if (!raw || typeof raw !== 'object') return { rows: [] };
  const o = raw as Record<string, unknown>;
  const rows = list(o) as T[];
  const count = o['@odata.count'] ?? o['count'] ?? o['inlineCount'];
  return typeof count === 'number' ? { rows, count } : { rows };
};

/**
 * An HTTP provider. Queries are translated to a URL (OData by default) and
 * fetched with GET; change sets are POSTed as JSON to the save endpoint.
 */
export const http = (base: string, opts: HttpOpts = {}): Provider => {
  const url = opts.url ?? toOData;
  const f = opts.fetch ?? globalThis.fetch;
  const root = base.replace(/\/+$/, '');
  const headers = { accept: 'application/json', ...opts.headers };

  const query = <T extends object = object>(q: Query<T>): Observable<Page<T>> =>
    defer(() => from(f(`${root}/${url(q)}`, { headers }).then(body))).pipe(
      map((raw) => toPage<T>(raw)),
    );

  const save = (rows: readonly Row[]): Observable<Saved> =>
    defer(() =>
      from(
        f(`${root}/${opts.savePath ?? 'save'}`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ rows }),
        }).then(body),
      ),
    ).pipe(map((raw) => raw as Saved));

  return { query, save };
};
