import { defer, from, type Observable } from 'rxjs';
import type { Row, Saved } from '../cache';
import { revive } from '../interp/json';
import { toOData } from '../interp/odata';
import type { Provider } from '../provider';
import { type Data, type Key, type Schema, fkRefs, isTemp, keyOf, keyProps, props, sameKey } from '../schema';
import { type HttpOpts, http } from './http';
import { pointsAt, ref, remap, topo } from './keys';

export interface ODataOpts extends Omit<HttpOpts, 'url' | 'savePath'> {
  /** Entity-set name per schema type; defaults to the type name. */
  readonly sets?: Readonly<Record<string, string>>;
}

const lit = (v: string | number): string =>
  typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`;

/** `(10)`, `('ALFKI')` or `(OrderID=10,ProductID=1)`. */
const keyPath = (s: Schema, t: string, key: Key): string => {
  if (typeof key !== 'object') return `(${lit(key)})`;
  const parts = keyProps(s, t).map((p, i) => {
    const v = key[i];
    if (v === undefined) throw new Error(`rxjs-breeze: incomplete key for ${t}`);
    return `${p}=${lit(v)}`;
  });
  return `(${parts.join(',')})`;
};

/** Drop `@odata.*` annotations and undefined values, recursively. */
const clean = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map((x) => clean(x));
  if (v === null || typeof v !== 'object' || v instanceof Date) return v;
  return Object.fromEntries(
    Object.entries(v as Data)
      .filter(([k, x]) => !k.startsWith('@') && x !== undefined)
      .map(([k, x]) => [k, clean(x)]),
  );
};

/**
 * An OData v4 provider that can write. Reads go through `http` with the
 * entity-set mapping; saves become one request per row: `POST` for added
 * rows (parents before the children that reference them), `PATCH` with the
 * changed properties for modified rows, `DELETE` for removed rows (children
 * first). Requests are sequential, not batched: a failure mid-way leaves the
 * earlier ones applied on the server and the store untouched.
 */
export const odata = (s: Schema, base: string, opts: ODataOpts = {}): Provider => {
  const sets = opts.sets ?? {};
  const set = (t: string): string => sets[t] ?? t;
  const reader = http(base, { ...opts, url: (q) => toOData({ ...q, type: set(q.type) }) });
  const f = opts.fetch ?? globalThis.fetch;
  const root = base.replace(/\/+$/, '');
  const refs = fkRefs(s);
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    prefer: 'return=representation',
    ...opts.headers,
  };

  const send = async (method: string, url: string, body?: Data): Promise<Data | null> => {
    const res = await f(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw new Error(`rxjs-breeze: ${method} ${url} failed: ${res.status} ${res.statusText}`);
    const text = await res.text();
    if (text === '') return null;
    const raw = clean(JSON.parse(text, revive));
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Data) : null;
  };

  const save = async (rows: readonly Row[]): Promise<Saved> => {
    const keyed = new Map<string, Key>();
    const added = topo(
      rows.filter((r) => r.state === 'added'),
      (a, b) => pointsAt(refs, a, b),
    );
    const changed = rows.filter((r) => r.state === 'changed');
    const removed = topo(
      rows.filter((r) => r.state === 'removed'),
      (a, b) => pointsAt(refs, b, a),
    );
    const saved: { type: string; data: object; was?: Key }[] = [];

    for (const r of added) {
      const data = remap(refs, keyed, r.type, props(r.data));
      const keys = keyProps(s, r.type);
      const body = clean(
        Object.fromEntries(Object.entries(data).filter(([k, v]) => !(keys.includes(k) && isTemp(v)))),
      ) as Data;
      const got = await send('POST', `${root}/${set(r.type)}`, body);
      if (!got) {
        throw new Error(
          `rxjs-breeze: POST ${set(r.type)} returned no entity; the server must honour Prefer: return=representation`,
        );
      }
      const full = { ...data, ...got };
      const key = keyOf(s, r.type, full);
      if (sameKey(key, r.key)) saved.push({ type: r.type, data: full });
      else {
        keyed.set(ref(r.type, r.key), key);
        saved.push({ type: r.type, data: full, was: r.key });
      }
    }

    for (const r of changed) {
      const data = remap(refs, keyed, r.type, props(r.data));
      const names = r.orig ? Object.keys(r.orig) : Object.keys(data);
      const delta = clean(Object.fromEntries(names.map((k) => [k, data[k]]))) as Data;
      const got = await send('PATCH', `${root}/${set(r.type)}${keyPath(s, r.type, r.key)}`, delta);
      saved.push({ type: r.type, data: got ? { ...data, ...got } : data });
    }

    const gone: { type: string; key: Key }[] = [];
    for (const r of removed) {
      await send('DELETE', `${root}/${set(r.type)}${keyPath(s, r.type, r.key)}`);
      gone.push({ type: r.type, key: r.key });
    }

    return { rows: saved, removed: gone };
  };

  return {
    query: reader.query,
    save: (rows: readonly Row[]): Observable<Saved> => defer(() => from(save(rows))),
  };
};
