import { and, type Path, type Pred, type Scalar } from './pred';

export interface Order {
  readonly path: string;
  readonly desc: boolean;
}

/**
 * A query is an immutable description, the `IQueryable` of this library.
 * Nothing runs until a provider executes it.
 */
export interface Query<T = unknown> {
  readonly type: string;
  readonly where?: Pred<T>;
  readonly order: readonly Order[];
  readonly skip?: number;
  readonly take?: number;
  readonly pick?: readonly string[];
  readonly expand: readonly string[];
  readonly count: boolean;
  readonly params: Readonly<Record<string, Scalar>>;
}

/** A query transform. Compose with `query(type, ...ops)` or RxJS `pipe`. */
export type Op<T = unknown> = (q: Query<T>) => Query<T>;

/** Build a query for an entity type from a list of transforms. */
export const query = <T = unknown>(type: string, ...ops: readonly Op<T>[]): Query<T> =>
  ops.reduce<Query<T>>((q, op) => op(q), { type, order: [], expand: [], count: false, params: {} });

/** Add predicates; several calls are combined with `and`. */
export const where =
  <T>(...preds: readonly Pred<T>[]): Op<T> =>
  (q) => {
    const next = q.where ? [q.where, ...preds] : [...preds];
    const [first] = next;
    if (!first) return q;
    return { ...q, where: next.length === 1 ? first : and(...next) };
  };

export const order =
  <T>(path: Path<T>, dir: 'asc' | 'desc' = 'asc'): Op<T> =>
  (q) => ({ ...q, order: [...q.order, { path, desc: dir === 'desc' }] });

export const skip =
  <T>(n: number): Op<T> =>
  (q) => ({ ...q, skip: n });

export const take =
  <T>(n: number): Op<T> =>
  (q) => ({ ...q, take: n });

/** Project to the given paths. Results are plain objects, not tracked entities. */
export const pick =
  <T>(...paths: readonly Path<T>[]): Op<T> =>
  (q) => ({ ...q, pick: paths });

/** Load navigation properties along dotted paths ("orders.lines"). */
export const expand =
  <T>(...navs: readonly Path<T>[]): Op<T> =>
  (q) => ({ ...q, expand: [...q.expand, ...navs] });

/** Ask the provider for the total count before skip/take. */
export const count =
  <T>(on = true): Op<T> =>
  (q) => ({ ...q, count: on });

/** Extra parameters passed through to the provider untouched. */
export const params =
  <T>(p: Readonly<Record<string, Scalar>>): Op<T> =>
  (q) => ({ ...q, params: { ...q.params, ...p } });
