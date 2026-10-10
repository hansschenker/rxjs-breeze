import type { Cmp, Pred } from '../pred';
import type { Query } from '../query';

/** Read a dotted path from an object. */
export const get = (row: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (o, k) => (o != null && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
      row,
    );

const norm = (v: unknown): unknown => (v instanceof Date ? v.getTime() : v);

/** Total order over scalars; nulls sort first, dates compare by time. */
export const compare = (a: unknown, b: unknown): number => {
  const x = norm(a);
  const y = norm(b);
  if (x == null || y == null) return x == null && y == null ? 0 : x == null ? -1 : 1;
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  if (typeof x === 'boolean' && typeof y === 'boolean') return Number(x) - Number(y);
  const p = String(x);
  const q = String(y);
  return p < q ? -1 : p > q ? 1 : 0;
};

const test = (op: Cmp, a: unknown, b: unknown): boolean => {
  switch (op) {
    case 'eq':
      return a === b;
    case 'ne':
      return a !== b;
    case 'gt':
      return a != null && b != null && compare(a, b) > 0;
    case 'ge':
      return a != null && b != null && compare(a, b) >= 0;
    case 'lt':
      return a != null && b != null && compare(a, b) < 0;
    case 'le':
      return a != null && b != null && compare(a, b) <= 0;
    case 'has':
      return typeof a === 'string' && typeof b === 'string' && a.includes(b);
    case 'starts':
      return typeof a === 'string' && typeof b === 'string' && a.startsWith(b);
    case 'ends':
      return typeof a === 'string' && typeof b === 'string' && a.endsWith(b);
  }
};

/** Compile a predicate to a JavaScript function: the local interpreter. */
export const toFn = <T>(p: Pred<T>): ((row: T) => boolean) => {
  switch (p.op) {
    case 'and': {
      const fs = p.preds.map((x) => toFn(x));
      return (r) => fs.every((f) => f(r));
    }
    case 'or': {
      const fs = p.preds.map((x) => toFn(x));
      return (r) => fs.some((f) => f(r));
    }
    case 'not': {
      const f = toFn(p.pred);
      return (r) => !f(r);
    }
    case 'any':
    case 'all': {
      const f = toFn(p.pred);
      const { path } = p;
      const every = p.op === 'all';
      return (r) => {
        const xs = get(r, path);
        if (!Array.isArray(xs)) return false;
        const list = xs as unknown[];
        return every ? list.every((x) => f(x)) : list.some((x) => f(x));
      };
    }
    case 'in': {
      const vs = p.values.map((v) => norm(v));
      const { path } = p;
      return (r) => vs.includes(norm(get(r, path)));
    }
    default: {
      const v = norm(p.value);
      const { op, path } = p;
      return (r) => test(op, norm(get(r, path)), v);
    }
  }
};

/** Execute the filter, order, skip, take and pick parts of a query against rows. */
export const run = <T>(q: Query<T>, rows: readonly T[]): T[] => {
  let out = q.where ? rows.filter(toFn(q.where)) : [...rows];
  if (q.order.length > 0) {
    const os = q.order;
    out = [...out].sort((a, b) => {
      for (const o of os) {
        const c = compare(get(a, o.path), get(b, o.path));
        if (c !== 0) return o.desc ? -c : c;
      }
      return 0;
    });
  }
  if (q.skip) out = out.slice(q.skip);
  if (q.take != null) out = out.slice(0, q.take);
  const { pick } = q;
  if (pick) out = out.map((r) => Object.fromEntries(pick.map((p) => [p, get(r, p)])) as T);
  return out;
};
