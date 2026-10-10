/**
 * Predicates: the expression tree behind `where`.
 *
 * A predicate is plain data and is never evaluated here. Interpreters turn it
 * into a JavaScript function (`toFn`), an OData `$filter` (`toFilter`) or JSON
 * (`toJson`). That is the LINQ provider idea: one expression, many executors.
 */

/** Scalar values a predicate can compare against. */
export type Scalar = string | number | boolean | Date | null;

/**
 * A property path on T. Known keys autocomplete; dotted paths such as
 * "customer.name" are accepted as well.
 */
export type Path<T> = (keyof T & string) | (string & {});

/** Binary comparison operators. */
export type Cmp = 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'has' | 'starts' | 'ends';

export type Pred<T = unknown> =
  | { readonly op: Cmp; readonly path: Path<T>; readonly value: Scalar }
  | { readonly op: 'in'; readonly path: Path<T>; readonly values: readonly Scalar[] }
  | { readonly op: 'and' | 'or'; readonly preds: readonly Pred<T>[] }
  | { readonly op: 'not'; readonly pred: Pred<T> }
  | { readonly op: 'any' | 'all'; readonly path: Path<T>; readonly pred: Pred<unknown> };

const cmp =
  (op: Cmp) =>
  <T>(path: Path<T>, value: Scalar): Pred<T> => ({ op, path, value });

export const eq = cmp('eq');
export const ne = cmp('ne');
export const gt = cmp('gt');
export const ge = cmp('ge');
export const lt = cmp('lt');
export const le = cmp('le');
/** String contains. */
export const has = cmp('has');
export const starts = cmp('starts');
export const ends = cmp('ends');

export const oneOf = <T>(path: Path<T>, values: readonly Scalar[]): Pred<T> => ({
  op: 'in',
  path,
  values,
});

export const and = <T>(...preds: readonly Pred<T>[]): Pred<T> => ({ op: 'and', preds });
export const or = <T>(...preds: readonly Pred<T>[]): Pred<T> => ({ op: 'or', preds });
export const not = <T>(pred: Pred<T>): Pred<T> => ({ op: 'not', pred });

/** True when at least one element of the collection at `path` satisfies `pred`. */
export const any = <T, U = unknown>(path: Path<T>, pred: Pred<U>): Pred<T> => ({
  op: 'any',
  path,
  pred,
});

/** True when every element of the collection at `path` satisfies `pred`. */
export const all = <T, U = unknown>(path: Path<T>, pred: Pred<U>): Pred<T> => ({
  op: 'all',
  path,
  pred,
});

/** Every property path a predicate reads, prefixed for nested any/all scopes. */
export const paths = (p: Pred, prefix = ''): string[] => {
  switch (p.op) {
    case 'and':
    case 'or':
      return p.preds.flatMap((x) => paths(x, prefix));
    case 'not':
      return paths(p.pred, prefix);
    case 'any':
    case 'all':
      return [prefix + p.path, ...paths(p.pred, `${prefix}${p.path}.`)];
    default:
      return [prefix + p.path];
  }
};
