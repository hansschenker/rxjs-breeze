import { BehaviorSubject, distinctUntilChanged, map, type Observable } from 'rxjs';
import {
  type Cache,
  type Merge,
  type Row,
  type Saved,
  accept,
  detach,
  dirty,
  drop,
  empty,
  fill,
  fromSnapshot,
  merge,
  patch,
  put,
  revert,
  row,
  select,
  toSnapshot,
} from './cache';
import type { Query } from './query';
import { type Key, type Schema, hasKey, keyId, keyKind, keyOf, keyProps } from './schema';

/**
 * The reactive shell around the pure cache: one BehaviorSubject holding the
 * cache, every operation a pure transform applied to it. This is the unit of
 * work: it tracks what changed and hands the change set to a provider on save.
 */
export interface Store {
  readonly schema: Schema;
  /** The whole cache as a stream; emits on every change. */
  readonly state$: Observable<Cache>;
  /** Pending changes as a stream. */
  readonly changes$: Observable<readonly Row[]>;
  readonly cache: () => Cache;
  readonly get: <T extends object = object>(type: string, key: Key) => T | undefined;
  /** Track a new entity; a temporary key is assigned when none is given. */
  readonly add: <T extends object>(type: string, data: T) => T;
  /** Track an existing entity as clean. */
  readonly attach: <T extends object>(type: string, data: T) => T;
  readonly patch: <T extends object>(type: string, key: Key, delta: Partial<T>) => T;
  readonly remove: (type: string, key: Key) => void;
  readonly detach: (type: string, key: Key) => void;
  /** Run a query against the cache now. */
  readonly run: <T extends object>(q: Query<T>) => T[];
  /** Run a query against the cache and re-run it whenever the cache changes. */
  readonly watch: <T extends object>(q: Query<T>) => Observable<T[]>;
  readonly changes: () => Row[];
  readonly revert: (type?: string, key?: Key) => void;
  /** Merge server data; returns the entities now in the cache, filled along `navs`. */
  readonly merge: <T extends object>(
    type: string,
    datas: readonly T[],
    how?: Merge,
    navs?: readonly string[],
  ) => T[];
  readonly accept: (sent: readonly Row[], saved: Saved) => void;
  readonly snapshot: () => string;
  readonly restore: (json: string) => void;
  /** Apply any pure cache transform. */
  readonly update: (f: (c: Cache) => Cache) => void;
}

const shallow = (a: unknown, b: unknown, depth: number): boolean => {
  if (Object.is(a, b)) return true;
  if (depth === 0 || typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x: unknown, i) => shallow(x, b[i], depth - 1))
    );
  }
  const pa = a as Record<string, unknown>;
  const pb = b as Record<string, unknown>;
  const ka = Object.keys(pa);
  return ka.length === Object.keys(pb).length && ka.every((k) => shallow(pa[k], pb[k], depth - 1));
};

const sameList = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((x, i) => shallow(x, b[i], 3));

export const store = (s: Schema, init: Cache = empty): Store => {
  const state = new BehaviorSubject<Cache>(init);
  let temp = 0;

  const update = (f: (c: Cache) => Cache): void => {
    const next = f(state.value);
    if (next !== state.value) state.next(next);
  };

  const withKey = <T extends object>(t: string, data: T): T => {
    if (hasKey(s, t, data)) return data;
    const [prop, ...more] = keyProps(s, t);
    if (!prop || more.length > 0) throw new Error(`rxjs-breeze: ${t} needs an explicit composite key`);
    temp += 1;
    const key = keyKind(s, t) === 'string' ? `tmp_${temp}` : -temp;
    return { ...data, [prop]: key };
  };

  const get = <T extends object = object>(t: string, key: Key): T | undefined => {
    const r = row<T>(state.value, t, key);
    return r && r.state !== 'removed' ? r.data : undefined;
  };

  return {
    schema: s,
    state$: state.asObservable(),
    changes$: state.pipe(
      map((c) => dirty(c)),
      distinctUntilChanged<Row[]>(sameList),
    ),
    cache: () => state.value,
    get,
    add: (t, data) => {
      const d = withKey(t, data);
      update((c) => put(s)(c, t, d, 'added'));
      return d;
    },
    attach: (t, data) => {
      update((c) => put(s)(c, t, data, 'clean'));
      return data;
    },
    patch: <T extends object>(t: string, key: Key, delta: Partial<T>): T => {
      const before = row<T>(state.value, t, key);
      if (!before) throw new Error(`rxjs-breeze: no ${t} with key ${keyId(key)}`);
      const data: T = { ...before.data, ...delta };
      update((c) => patch(s)(c, t, key, delta));
      return get<T>(t, keyOf(s, t, data)) ?? data;
    },
    remove: (t, key) => update((c) => drop(c, t, key)),
    detach: (t, key) => update((c) => detach(c, t, key)),
    run: (q) => select(s)(state.value, q),
    watch: <T extends object>(q: Query<T>): Observable<T[]> =>
      state.pipe(
        map((c) => select(s)(c, q)),
        distinctUntilChanged<T[]>(sameList),
      ),
    changes: () => dirty(state.value),
    revert: (t, key) => update((c) => revert(c, t, key)),
    merge: <T extends object>(
      t: string,
      datas: readonly T[],
      how: Merge = 'keep',
      navs: readonly string[] = [],
    ): T[] => {
      let out: T[] = [];
      update((c) => {
        const m = merge(s)(c, t, datas, how);
        out = m.data;
        return m.cache;
      });
      return fill(s)(state.value, t, out, navs);
    },
    accept: (sent, saved) => update((c) => accept(s)(c, sent, saved)),
    snapshot: () => toSnapshot(state.value),
    restore: (json) => state.next(fromSnapshot(json)),
    update,
  };
};
