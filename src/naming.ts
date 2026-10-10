/**
 * Naming conventions translate property names at the wire boundary. The
 * schema and the store always use client names; providers rename on the
 * way out (query paths, bodies, key paths) and on the way in (responses).
 */
import type { Row } from './cache';
import type { Pred } from './pred';
import type { Query } from './query';

export interface Naming {
  /** Client name to server name. */
  readonly toServer: (name: string) => string;
  /** Server name to client name. */
  readonly toClient: (name: string) => string;
}

export const naming = (toServer: (name: string) => string, toClient: (name: string) => string): Naming => ({
  toServer,
  toClient,
});

const upperFirst = (n: string): string => n.charAt(0).toUpperCase() + n.slice(1);
const lowerFirst = (n: string): string => n.charAt(0).toLowerCase() + n.slice(1);

/** Names as they are. */
export const same: Naming = naming(
  (n) => n,
  (n) => n,
);

/** camelCase on the client, PascalCase on the server: Breeze's `NamingConvention.camelCase`. */
export const camel: Naming = naming(upperFirst, lowerFirst);

/** camelCase on the client, snake_case on the server. */
export const snake: Naming = naming(
  (n) => n.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`),
  (n) => n.replace(/_+([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
);

const path =
  (f: (name: string) => string) =>
  (p: string): string =>
    p.split('.').map(f).join('.');

/** Rename every property path in a predicate. */
export const renamePred =
  (f: (name: string) => string) =>
  <T>(p: Pred<T>): Pred<T> => {
    switch (p.op) {
      case 'and':
      case 'or':
        return { ...p, preds: p.preds.map((x) => renamePred(f)(x)) };
      case 'not':
        return { ...p, pred: renamePred(f)(p.pred) };
      case 'any':
      case 'all':
        return { ...p, path: path(f)(p.path), pred: renamePred(f)(p.pred) };
      default:
        return { ...p, path: path(f)(p.path) };
    }
  };

/** Rename every property path in a query. The type name is left alone; map it with entity-set options. */
export const renameQuery =
  (f: (name: string) => string) =>
  <T>(q: Query<T>): Query<T> => ({
    ...q,
    ...(q.where ? { where: renamePred(f)(q.where) } : {}),
    order: q.order.map((o) => ({ ...o, path: path(f)(o.path) })),
    ...(q.pick ? { pick: q.pick.map((p) => path(f)(p)) } : {}),
    expand: q.expand.map((p) => path(f)(p)),
  });

/** Rename object keys deeply, through nested objects and arrays. Dates and keys with `@` (annotations, bindings) are left alone. */
export const renameData =
  (f: (name: string) => string) =>
  (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map((x) => renameData(f)(x));
    if (v === null || typeof v !== 'object' || v instanceof Date) return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k.includes('@') ? k : f(k), renameData(f)(x)]),
    );
  };

/** Rename the data and original values of a tracked row. */
export const renameRow =
  (f: (name: string) => string) =>
  (r: Row): Row => ({
    ...r,
    data: renameData(f)(r.data) as object,
    orig: r.orig === null ? null : (renameData(f)(r.orig) as object),
  });
