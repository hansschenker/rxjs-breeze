import { defer, of, type Observable } from 'rxjs';
import { type Cache, type Row, type Saved, detach, empty, live, merge, put, select } from '../cache';
import { run } from '../interp/fn';
import type { Page, Provider } from '../provider';
import type { Query } from '../query';
import { type Key, type Schema, asKey, fkRefs, keyId, keyOf, keyProps, props, sameKey } from '../schema';

export interface Memory extends Provider {
  readonly rows: <T extends object = object>(type: string) => T[];
  readonly cache: () => Cache;
}

const isTemp = (k: unknown): boolean =>
  (typeof k === 'number' && k < 0) || (typeof k === 'string' && k.startsWith('tmp_'));

/**
 * An in-memory provider. Queries run through the compiled-function
 * interpreter; saves assign real keys and fix up foreign keys the way a server
 * would. Useful for tests, demos and offline work.
 */
export const memory = (s: Schema, seed: Readonly<Record<string, readonly object[]>> = {}): Memory => {
  let db = Object.entries(seed).reduce<Cache>((c, [t, ds]) => merge(s)(c, t, ds).cache, empty);
  let next = 1;
  for (const t of Object.keys(s)) {
    for (const d of live(db, t)) {
      const k = keyOf(s, t, d);
      if (typeof k === 'number' && k >= next) next = k + 1;
    }
  }
  const refs = fkRefs(s);

  const query = <T extends object = object>(q: Query<T>): Observable<Page<T>> =>
    defer(() => {
      const rows = select(s)(db, q);
      if (!q.count) return of({ rows });
      const all = run({ ...q, skip: undefined, take: undefined, pick: undefined }, live<T>(db, q.type));
      return of({ rows, count: all.length });
    });

  const save = (rows: readonly Row[]): Observable<Saved> =>
    defer(() => {
      const keyed = new Map<string, Key>();
      let items = rows.map((r) => ({ r, data: props(r.data) }));
      items = items.map(({ r, data }) => {
        const [kp] = keyProps(s, r.type);
        if (r.state !== 'added' || !kp || !isTemp(data[kp])) return { r, data };
        const real = typeof data[kp] === 'number' ? next++ : `k${next++}`;
        keyed.set(`${r.type}:${keyId(r.key)}`, real);
        return { r, data: { ...data, [kp]: real } };
      });
      items = items.map(({ r, data }) => ({
        r,
        data: refs
          .filter((x) => x.type === r.type)
          .reduce((d, x) => {
            const fk = asKey(d[x.fk]);
            const real = fk === undefined ? undefined : keyed.get(`${x.to}:${keyId(fk)}`);
            return real === undefined ? d : { ...d, [x.fk]: real };
          }, data),
      }));
      const saved: { type: string; data: object; was?: Key }[] = [];
      const removed: { type: string; key: Key }[] = [];
      for (const { r, data } of items) {
        if (r.state === 'removed') {
          db = detach(db, r.type, r.key);
          removed.push({ type: r.type, key: r.key });
          continue;
        }
        db = put(s)(db, r.type, data, 'clean');
        const key = keyOf(s, r.type, data);
        saved.push(sameKey(key, r.key) ? { type: r.type, data } : { type: r.type, data, was: r.key });
      }
      return of({ rows: saved, removed });
    });

  return { query, save, rows: (t) => live(db, t), cache: () => db };
};
