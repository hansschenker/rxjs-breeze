import { defer, from, type Observable } from 'rxjs';
import type { Row, Saved } from '../cache';
import { revive } from '../interp/json';
import { toOData } from '../interp/odata';
import type { Provider } from '../provider';
import {
  type Data,
  type Key,
  type Schema,
  asKey,
  def,
  fkRefs,
  isTemp,
  keyOf,
  keyProps,
  props,
  sameKey,
} from '../schema';
import { type BatchReq, buildJson, buildMultipart, parseJson, parseMultipart } from './batch';
import { type HttpOpts, http } from './http';
import { pointsAt, ref, remap, topo } from './keys';

export type BatchMode = 'multipart' | 'json';

export interface ODataOpts extends Omit<HttpOpts, 'url' | 'savePath'> {
  /** Entity-set name per schema type; defaults to the type name. */
  readonly sets?: Readonly<Record<string, string>>;
  /**
   * Send each save as one `$batch` changeset, applied atomically by the server.
   * `'multipart'` is the OData 4.0 format, `'json'` the OData 4.01 one.
   * Default: one request per row, in dependency order.
   */
  readonly batch?: BatchMode;
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

const parse = (text: string): Data | null => {
  if (text.trim() === '') return null;
  const raw = clean(JSON.parse(text, revive));
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Data) : null;
};

interface Done {
  readonly rows: { type: string; data: object; was?: Key }[];
  readonly removed: { type: string; key: Key }[];
}

/**
 * An OData v4 provider that reads and writes. Reads go through `http` with
 * the entity-set mapping. Saves become `POST` for added rows (parents before
 * the children that reference them), `PATCH` with the changed properties for
 * modified rows and `DELETE` for removed rows (children first), either one
 * request at a time or as one atomic `$batch` changeset.
 */
export const odata = (s: Schema, base: string, opts: ODataOpts = {}): Provider => {
  const sets = opts.sets ?? {};
  const set = (t: string): string => sets[t] ?? t;
  const reader = http(base, { ...opts, url: (q) => toOData({ ...q, type: set(q.type) }) });
  const f = opts.fetch ?? globalThis.fetch;
  const root = base.replace(/\/+$/, '');
  const refs = fkRefs(s);
  const json = { accept: 'application/json', 'content-type': 'application/json', prefer: 'return=representation' };
  const headers = { ...json, ...opts.headers };

  const plan = (rows: readonly Row[]) => ({
    added: topo(
      rows.filter((r) => r.state === 'added'),
      (a, b) => pointsAt(refs, a, b),
    ),
    changed: rows.filter((r) => r.state === 'changed'),
    removed: topo(
      rows.filter((r) => r.state === 'removed'),
      (a, b) => pointsAt(refs, b, a),
    ),
  });

  const url = (r: Row): string =>
    `${root}/${set(r.type)}${r.state === 'added' ? '' : keyPath(s, r.type, r.key)}`;

  /** POST body: the entity without temporary key values. */
  const postBody = (r: Row, data: Data): Data => {
    const keys = keyProps(s, r.type);
    return Object.fromEntries(Object.entries(data).filter(([k, v]) => !(keys.includes(k) && isTemp(v))));
  };

  /** PATCH body: only the properties recorded as changed. */
  const delta = (r: Row, data: Data): Data => {
    const names = r.orig ? Object.keys(r.orig) : Object.keys(data);
    return Object.fromEntries(names.map((k) => [k, data[k]]));
  };

  /** Record one row's outcome, learning real keys from created entities. */
  const finish = (done: Done, keyed: Map<string, Key>, r: Row, got: Data | null): void => {
    if (r.state === 'removed') {
      done.removed.push({ type: r.type, key: r.key });
      return;
    }
    const data = remap(refs, keyed, r.type, props(r.data));
    if (r.state !== 'added') {
      done.rows.push({ type: r.type, data: got ? { ...data, ...got } : data });
      return;
    }
    if (!got) {
      throw new Error(
        `rxjs-breeze: POST ${set(r.type)} returned no entity; the server must honour Prefer: return=representation`,
      );
    }
    const full = remap(refs, keyed, r.type, { ...data, ...got });
    const key = keyOf(s, r.type, full);
    if (sameKey(key, r.key)) done.rows.push({ type: r.type, data: full });
    else {
      keyed.set(ref(r.type, r.key), key);
      done.rows.push({ type: r.type, data: full, was: r.key });
    }
  };

  const saveEach = async (rows: readonly Row[]): Promise<Saved> => {
    const p = plan(rows);
    const keyed = new Map<string, Key>();
    const done: Done = { rows: [], removed: [] };
    for (const r of [...p.added, ...p.changed, ...p.removed]) {
      const data = remap(refs, keyed, r.type, props(r.data));
      const method = r.state === 'added' ? 'POST' : r.state === 'changed' ? 'PATCH' : 'DELETE';
      const body = r.state === 'added' ? postBody(r, data) : r.state === 'changed' ? delta(r, data) : undefined;
      const target = url(r);
      const res = await f(target, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(clean(body)),
      });
      if (!res.ok) throw new Error(`rxjs-breeze: ${method} ${target} failed: ${res.status} ${res.statusText}`);
      finish(done, keyed, r, parse(await res.text()));
    }
    return done;
  };

  /** Replace foreign keys that point at rows created in the same batch by `nav@odata.bind: "$id"`. */
  const bind = (r: Row, data: Data, cids: ReadonlyMap<string, string>): { body: Data; deps: string[] } => {
    let body = data;
    const deps: string[] = [];
    for (const x of refs.filter((x) => x.type === r.type)) {
      const fk = asKey(body[x.fk]);
      const cid = fk === undefined || !isTemp(fk) ? undefined : cids.get(ref(x.to, fk));
      if (cid === undefined) continue;
      const nav = Object.entries(def(s, r.type).navs ?? {}).find(
        ([, n]) => !n.many && n.fk === x.fk && n.to === x.to,
      )?.[0];
      if (nav === undefined) {
        throw new Error(
          `rxjs-breeze: ${r.type}.${x.fk} refers to a new ${x.to}; declare a navigation for it so $batch can bind it by Content-ID`,
        );
      }
      const rest: Data = { ...body };
      delete rest[x.fk];
      body = { ...rest, [`${nav}@odata.bind`]: `$${cid}` };
      deps.push(cid);
    }
    return { body, deps };
  };

  const saveBatch = async (rows: readonly Row[], mode: BatchMode): Promise<Saved> => {
    const p = plan(rows);
    const all = [...p.added, ...p.changed, ...p.removed];
    const cids = new Map(p.added.map((r, i) => [ref(r.type, r.key), String(i + 1)]));
    const steps = all.map((r, i): { row: Row; req: BatchReq } => {
      const id = String(i + 1);
      if (r.state === 'removed') return { row: r, req: { id, method: 'DELETE', url: url(r), headers: {} } };
      const data = props(r.data);
      const { body, deps } = bind(r, r.state === 'added' ? postBody(r, data) : delta(r, data), cids);
      return {
        row: r,
        req: {
          id,
          method: r.state === 'added' ? 'POST' : 'PATCH',
          url: url(r),
          headers: json,
          body: clean(body),
          dependsOn: deps,
        },
      };
    });
    const reqs = steps.map((x) => x.req);
    const payload = mode === 'json' ? buildJson(reqs) : buildMultipart(reqs);
    const res = await f(`${root}/$batch`, {
      method: 'POST',
      headers: {
        ...opts.headers,
        accept: mode === 'json' ? 'application/json' : 'multipart/mixed',
        'content-type': payload.contentType,
        'odata-version': '4.0',
      },
      body: payload.body,
    });
    if (!res.ok) throw new Error(`rxjs-breeze: POST $batch failed: ${res.status} ${res.statusText}`);
    const ct = res.headers.get('content-type') ?? '';
    const text = await res.text();
    const results = ct.includes('json') ? parseJson(text) : parseMultipart(text, ct);
    const failed = results.find((x) => x.status < 200 || x.status >= 300);
    if (failed) {
      throw new Error(`rxjs-breeze: $batch failed: ${failed.status} ${failed.statusText} ${failed.body.slice(0, 300)}`.trim());
    }
    if (results.length < steps.length) {
      throw new Error(`rxjs-breeze: $batch returned ${results.length} responses for ${steps.length} requests`);
    }
    const byId = new Map(results.flatMap((x) => (x.id === undefined ? [] : [[x.id, x] as const])));
    const keyed = new Map<string, Key>();
    const done: Done = { rows: [], removed: [] };
    steps.forEach((step, i) => {
      const r = byId.get(step.req.id) ?? results[i];
      finish(done, keyed, step.row, r ? parse(r.body) : null);
    });
    return done;
  };

  return {
    query: reader.query,
    save: (rows: readonly Row[]): Observable<Saved> =>
      defer(() => from(opts.batch ? saveBatch(rows, opts.batch) : saveEach(rows))),
  };
};
