/**
 * The pure core: an identity-map cache with change tracking, expressed as
 * functions from Cache to Cache. Nothing here is stateful or reactive; the
 * store wraps these in a BehaviorSubject.
 */
import { equal } from './eq';
import { run } from './interp/fn';
import { revive } from './interp/json';
import { paths } from './pred';
import type { Query } from './query';
import {
  type Data,
  type Key,
  type Nav,
  type Schema,
  asKey,
  def,
  fkRefs,
  keyId,
  keyOf,
  propDef,
  props,
  sameKey,
} from './schema';

export type State = 'clean' | 'added' | 'changed' | 'removed';

/** A tracked entity. */
export interface Row<T extends object = object> {
  readonly type: string;
  readonly key: Key;
  readonly data: T;
  readonly state: State;
  /** Original values of changed properties; null unless state is 'changed'. */
  readonly orig: Readonly<Partial<T>> | null;
}

export type Group = ReadonlyMap<string, Row>;
export type Cache = Readonly<Record<string, Group>>;

/** What a merge does when the cache already holds a dirty version of an incoming entity. */
export type Merge = 'keep' | 'overwrite' | 'skip';

/** What a provider reports after a save. */
export interface Saved {
  readonly rows: readonly { readonly type: string; readonly data: object; readonly was?: Key }[];
  readonly removed?: readonly { readonly type: string; readonly key: Key }[];
}

export const empty: Cache = {};

export const rows = <T extends object = object>(c: Cache, t: string): Row<T>[] =>
  [...(c[t]?.values() ?? [])] as Row<T>[];

export const row = <T extends object = object>(c: Cache, t: string, key: Key): Row<T> | undefined =>
  c[t]?.get(keyId(key)) as Row<T> | undefined;

/** Entities of a type that are not marked removed. */
export const live = <T extends object = object>(c: Cache, t: string): T[] =>
  rows<T>(c, t)
    .filter((r) => r.state !== 'removed')
    .map((r) => r.data);

/** Rows with pending changes. */
export const dirty = (c: Cache): Row[] =>
  Object.values(c).flatMap((g) => [...g.values()].filter((r) => r.state !== 'clean'));

const set = (c: Cache, r: Row): Cache => {
  const g = new Map(c[r.type]);
  g.set(keyId(r.key), r);
  return { ...c, [r.type]: g };
};

const del = (c: Cache, t: string, key: Key): Cache => {
  const g = c[t];
  const id = keyId(key);
  if (!g?.has(id)) return c;
  const next = new Map(g);
  next.delete(id);
  return { ...c, [t]: next };
};

/** Insert or replace an entity with the given state. */
export const put =
  (s: Schema) =>
  <T extends object>(c: Cache, t: string, data: T, state: State = 'clean'): Cache =>
    set(c, { type: t, key: keyOf(s, t, data), data, state, orig: null });

/** A partial update of one value: objects may themselves be partial; lists and dates are replaced whole. */
export type Part<V> = V extends Date | readonly unknown[] ? V : V extends object ? Patch<V> : V;

/** A partial update: complex-typed properties may themselves be partial; lists and dates are replaced whole. */
export type Patch<T> = { readonly [K in keyof T]?: Part<T[K]> };

const isObj = (v: unknown): v is object =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/** Merge a delta into data, merging declared complex values instead of replacing them. */
export const blend = (s: Schema, t: string, data: object, delta: object): object => {
  const out: Data = { ...props(data) };
  const decl = def(s, t).props ?? {};
  for (const [k, v] of Object.entries(props(delta))) {
    const p = decl[k];
    const pd = p === undefined ? undefined : propDef(p);
    const cur = out[k];
    out[k] =
      pd !== undefined && 'complex' in pd && !pd.many && isObj(v) && isObj(cur)
        ? blend(s, pd.complex, cur, v)
        : v;
  }
  return out;
};

/** Apply a partial update, recording original values the first time a property changes. */
export const patch =
  (s: Schema) =>
  <T extends object>(c: Cache, t: string, key: Key, delta: Patch<T>): Cache => {
    const r = row<T>(c, t, key);
    if (!r) throw new Error(`rxjs-breeze: no ${t} with key ${keyId(key)}`);
    if (r.state === 'removed') throw new Error(`rxjs-breeze: ${t} ${keyId(key)} is removed`);
    const data = blend(s, t, r.data, delta) as T;
    if (r.state === 'added') {
      const next = keyOf(s, t, data);
      return set(sameKey(next, r.key) ? c : del(c, t, r.key), { ...r, key: next, data });
    }
    const orig: Data = { ...(r.orig ?? {}) };
    const was = props(r.data);
    for (const k of Object.keys(delta)) if (!(k in orig)) orig[k] = was[k];
    return set(c, { ...r, data, state: 'changed', orig: orig as Partial<T> });
  };

/** Remove an entity: added rows vanish, others are marked 'removed' until saved. */
export const drop = (c: Cache, t: string, key: Key): Cache => {
  const r = row(c, t, key);
  if (!r) return c;
  return r.state === 'added' ? del(c, t, key) : set(c, { ...r, state: 'removed' });
};

/** Forget an entity without tracking a deletion. */
export const detach = (c: Cache, t: string, key: Key): Cache => del(c, t, key);

/** Undo pending changes: for one entity, one type, or everything. */
export const revert = (c: Cache, t?: string, key?: Key): Cache => {
  if (t !== undefined && key !== undefined) {
    const r = row(c, t, key);
    if (!r || r.state === 'clean') return c;
    if (r.state === 'added') return del(c, t, key);
    return set(c, { ...r, data: { ...r.data, ...(r.orig ?? {}) }, state: 'clean', orig: null });
  }
  return dirty(c)
    .filter((r) => t === undefined || r.type === t)
    .reduce((acc, r) => revert(acc, r.type, r.key), c);
};

interface Split {
  readonly data: object;
  readonly nested: readonly { readonly type: string; readonly datas: readonly object[] }[];
}

/** Separate nested navigation objects from an entity so they can be stored in their own groups. */
const split = (s: Schema, t: string, raw: object): Split => {
  const navs = def(s, t).navs ?? {};
  let data: Data = { ...props(raw) };
  const nested: { type: string; datas: object[] }[] = [];
  for (const [name, nav] of Object.entries(navs)) {
    if (!(name in data)) continue;
    const { [name]: v, ...rest } = data;
    data = rest;
    if (v == null) continue;
    nested.push({ type: nav.to, datas: Array.isArray(v) ? (v as object[]) : [v as object] });
  }
  return { data, nested };
};

export interface Merged<T extends object> {
  readonly cache: Cache;
  readonly data: T[];
}

/**
 * Merge server data into the cache. Nested navigation objects are normalized
 * into their own groups and stripped from the parent. Clean entities are
 * replaced; dirty ones follow the merge strategy.
 */
export const merge =
  (s: Schema) =>
  <T extends object>(c: Cache, t: string, datas: readonly T[], how: Merge = 'keep'): Merged<T> => {
    let cache = c;
    const data: T[] = [];
    for (const raw of datas) {
      const sp = split(s, t, raw);
      for (const n of sp.nested) cache = merge(s)(cache, n.type, n.datas, how).cache;
      const flat = sp.data as T;
      const key = keyOf(s, t, flat);
      const cur = row<T>(cache, t, key);
      if (!cur || cur.state === 'clean') {
        const next = cur && equal(cur.data, flat) ? cur.data : flat;
        if (!cur || next !== cur.data) {
          cache = set(cache, { type: t, key, data: next, state: 'clean', orig: null });
        }
        data.push(next);
      } else if (how === 'overwrite') {
        cache = set(cache, { type: t, key, data: flat, state: 'clean', orig: null });
        data.push(flat);
      } else if (how === 'keep') {
        data.push(cur.data);
      }
    }
    return { cache, data };
  };

const navOf = (s: Schema, t: string, name: string): Nav => {
  const nav = def(s, t).navs?.[name];
  if (!nav) throw new Error(`rxjs-breeze: ${t} has no navigation "${name}"`);
  return nav;
};

const children = (s: Schema, c: Cache, t: string, nav: Nav, data: object): object[] => {
  const k = keyOf(s, t, data);
  return live(c, nav.to).filter((d) => {
    const fk = asKey(props(d)[nav.fk]);
    return fk !== undefined && sameKey(fk, k);
  });
};

const parent = (c: Cache, nav: Nav, data: object): object | null => {
  const fk = asKey(props(data)[nav.fk]);
  const target = fk === undefined ? undefined : row(c, nav.to, fk);
  return target && target.state !== 'removed' ? target.data : null;
};

const resolve = (s: Schema, c: Cache, t: string, data: object, path: string): object => {
  const [name = '', ...rest] = path.split('.');
  const nav = navOf(s, t, name);
  const have = props(data)[name];
  const deeper = rest.join('.');
  const go = (d: object): object => (deeper ? resolve(s, c, nav.to, d, deeper) : d);
  if (nav.many) {
    const list = Array.isArray(have) ? (have as object[]) : children(s, c, t, nav, data);
    return { ...data, [name]: list.map((d) => go(d)) };
  }
  const one = have !== undefined ? (have as object | null) : parent(c, nav, data);
  return { ...data, [name]: one === null ? null : go(one) };
};

/** Fill navigation properties from the cache along the given dotted paths. */
export const fill =
  (s: Schema) =>
  <T extends object>(c: Cache, t: string, datas: readonly T[], navs: readonly string[]): T[] =>
    navs.length === 0
      ? [...datas]
      : datas.map((d) => navs.reduce<object>((acc, p) => resolve(s, c, t, acc, p), d) as T);

/** Navigation prefixes of the given paths, e.g. "customer.name" -> ["customer"]. */
const navPrefixes = (s: Schema, t: string, ps: readonly string[]): string[] => {
  const out = new Set<string>();
  for (const p of ps) {
    let cur = t;
    const acc: string[] = [];
    for (const seg of p.split('.')) {
      const nav = def(s, cur).navs?.[seg];
      if (!nav) break;
      acc.push(seg);
      out.add(acc.join('.'));
      cur = nav.to;
    }
  }
  return [...out];
};

const strip = <T extends object>(datas: readonly T[], names: readonly string[]): T[] =>
  names.length === 0
    ? [...datas]
    : datas.map((d) => {
        const copy: Data = { ...props(d) };
        for (const n of names) delete copy[n];
        return copy as T;
      });

/**
 * Run a query against the cache: filter, order, page, fill navigations, then
 * project. Navigations used by the filter or ordering are resolved on the fly
 * and stripped again unless the query asked for them.
 */
export const select =
  (s: Schema) =>
  <T extends object>(c: Cache, q: Query<T>): T[] => {
    def(s, q.type);
    const used = navPrefixes(s, q.type, [
      ...(q.where ? paths(q.where) : []),
      ...q.order.map((o) => o.path),
    ]);
    const pre = fill(s)(c, q.type, live<T>(c, q.type), used);
    const { pick, ...plain } = q;
    const base = run<T>(plain, pre);
    const wanted = new Set(q.expand.map((e) => e.split('.')[0] ?? ''));
    const extra = used.filter((u) => !u.includes('.') && !wanted.has(u));
    const full = fill(s)(c, q.type, strip(base, extra), q.expand);
    return pick ? run<T>({ ...q, where: undefined, order: [], skip: undefined, take: undefined }, full) : full;
  };

/** Re-point foreign keys that referenced an old key of type `t`, re-keying rows whose key includes it. */
const fixKeys = (s: Schema, c: Cache, t: string, was: Key, now: Key): Cache => {
  let cache = c;
  for (const ref of fkRefs(s).filter((r) => r.to === t)) {
    for (const r of rows(cache, ref.type)) {
      const fk = asKey(props(r.data)[ref.fk]);
      if (fk === undefined || !sameKey(fk, was)) continue;
      const data = { ...r.data, [ref.fk]: now };
      const key = keyOf(s, ref.type, data);
      cache = set(sameKey(key, r.key) ? cache : del(cache, ref.type, r.key), { ...r, key, data });
    }
  }
  return cache;
};

/** Apply a provider's save result: mark rows clean, re-key, fix foreign keys, drop deletions. */
export const accept =
  (s: Schema) =>
  (c: Cache, sent: readonly Row[], saved: Saved): Cache => {
    let cache = c;
    for (const { type: t, key } of saved.removed ?? []) cache = del(cache, t, key);
    for (const { type: t, data, was } of saved.rows) {
      const key = keyOf(s, t, data);
      if (was !== undefined && !sameKey(was, key)) {
        cache = del(cache, t, was);
        cache = fixKeys(s, cache, t, was, key);
      }
      cache = set(cache, { type: t, key, data, state: 'clean', orig: null });
    }
    for (const r of sent) {
      const cur = row(cache, r.type, r.key);
      if (!cur) continue;
      if (cur.state === 'removed') cache = del(cache, r.type, r.key);
      else if (cur.state !== 'clean') cache = set(cache, { ...cur, state: 'clean', orig: null });
    }
    return cache;
  };

/** Serialize the whole cache, pending changes included. */
export const toSnapshot = (c: Cache): string =>
  JSON.stringify(Object.fromEntries(Object.entries(c).map(([t, g]) => [t, [...g.values()]])));

export const fromSnapshot = (text: string): Cache => {
  const raw = JSON.parse(text, revive) as Record<string, Row[]>;
  return Object.fromEntries(
    Object.entries(raw).map(([t, rs]) => [t, new Map(rs.map((r) => [keyId(r.key), r]))]),
  );
};
