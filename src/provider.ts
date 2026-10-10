import { map, of, tap, type Observable } from 'rxjs';
import type { Merge, Row, Saved } from './cache';
import type { Query } from './query';
import type { Store } from './store';

/** One page of results, with the total count when the query asked for it. */
export interface Page<T> {
  readonly rows: readonly T[];
  readonly count?: number;
}

/**
 * A provider executes queries and saves change sets: the `IQueryProvider` of
 * this library. The query stays data; the provider decides how to run it.
 */
export interface Provider {
  readonly query: <T extends object = object>(q: Query<T>) => Observable<Page<T>>;
  readonly save: (rows: readonly Row[]) => Observable<Saved>;
}

/** Where a fetch reads from. `localFirst` goes remote only when the cache has no match. */
export type Source = 'remote' | 'local' | 'localFirst';

export interface FetchOpts {
  readonly from?: Source;
  readonly merge?: Merge;
}

/** A store wired to a provider: fetch merges results into the store, save sends its changes. */
export interface Client {
  readonly store: Store;
  readonly provider: Provider;
  readonly page: <T extends object>(q: Query<T>, opts?: FetchOpts) => Observable<Page<T>>;
  readonly fetch: <T extends object>(q: Query<T>, opts?: FetchOpts) => Observable<T[]>;
  /** Save the given rows, or every pending change. */
  readonly save: (rows?: readonly Row[]) => Observable<Saved>;
}

export const client = (store: Store, provider: Provider): Client => {
  const page = <T extends object>(
    q: Query<T>,
    { from = 'remote', merge = 'keep' }: FetchOpts = {},
  ): Observable<Page<T>> => {
    if (from === 'local') return of({ rows: store.run(q) });
    if (from === 'localFirst') {
      const local = store.run(q);
      if (local.length > 0) return of({ rows: local });
    }
    return provider
      .query(q)
      .pipe(map((p) => (q.pick ? p : { ...p, rows: store.merge(q.type, p.rows, merge, q.expand) })));
  };
  return {
    store,
    provider,
    page,
    fetch: (q, opts) => page(q, opts).pipe(map((p) => [...p.rows])),
    save: (rows = store.changes()) =>
      rows.length === 0
        ? of<Saved>({ rows: [] })
        : provider.save(rows).pipe(tap((saved) => store.accept(rows, saved))),
  };
};
