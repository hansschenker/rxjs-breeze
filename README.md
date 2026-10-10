# rxjs-breeze

The ideas of [Breeze.js](https://github.com/Breeze/breeze.js) rebuilt as a small, functional TypeScript library on RxJS.

A **query is data**. A **provider** executes it, locally or over HTTP. A **store** caches entities by identity, tracks changes, and re-runs your queries whenever the cache changes.

No classes, no long names, no framework.

## The idea: a LINQ provider for the browser

LINQ separates *what* you ask for (an expression tree, `IQueryable`) from *who* answers it (an `IQueryProvider`). Breeze brought that to JavaScript in 2012. rxjs-breeze keeps the split and makes every piece a plain value or a pure function:

| LINQ | rxjs-breeze |
| --- | --- |
| `IQueryable<T>` | `Query<T>`, an immutable object built with `query(type, ...ops)` |
| Expression tree | `Pred<T>`, built with `eq`, `gt`, `and`, `any`, ... |
| `IQueryProvider.Execute` | `Provider.query(q)`, returns an `Observable<Page<T>>` |
| LINQ to SQL / LINQ to Objects | `http` (translates to OData or JSON) / `memory` (compiles to a JS function) |
| `DbContext` | `store`: identity map, change tracking, `saveChanges` as `save` |

The same query runs against the server and against the local cache, because interpreters are separate from the query:

| Interpreter | Turns a query into | Used by |
| --- | --- | --- |
| `toFn` | a JavaScript predicate function | `memory`, `store.run`, `store.watch` |
| `toOData` / `toFilter` | an OData v4 URL / `$filter` expression | `http` (default) |
| `toJson` / `fromJson` | JSON for a JSON-speaking server | `http` with a custom `url` |

## Install

```bash
npm install rxjs-breeze rxjs
```

## Quick start

```ts
import {
  client, count, eq, expand, gt, http, order, query, schema, store, take, where,
} from 'rxjs-breeze';

// 1. Describe your model once: keys and navigations. Types are your own interfaces.
const nw = schema({
  Customer: {
    key: 'id',
    props: { id: 'number', name: 'string', city: 'string' },
    navs: { orders: { to: 'Order', fk: 'customerId', many: true } },
  },
  Order: {
    key: 'id',
    props: { id: 'number', customerId: 'number', total: 'number' },
    navs: { customer: { to: 'Customer', fk: 'customerId' } },
  },
});

interface Customer { id: number; name: string; city: string; orders?: Order[] }
interface Order { id: number; customerId: number; total: number; customer?: Customer | null }

// 2. A store wired to a provider.
const db = client(store(nw), http('https://example.com/odata'));

// 3. A query is a value.
const big = query<Order>(
  'Order',
  where(gt('total', 100)),
  order('total', 'desc'),
  expand('customer'),
  take(20),
  count(),
);

// 4. Run it remotely. On the wire:
//    Order?$filter=total gt 100&$orderby=total desc&$top=20&$expand=customer&$count=true
db.page(big).subscribe(({ rows, count }) => console.log(count, rows[0]?.customer?.name));

// 5. Run the same query against the cache, and keep it running.
db.store.watch(big).subscribe((orders) => render(orders));

// 6. Edit, then save the change set. Temporary keys are fixed up from the server's reply.
db.store.patch<Order>('Order', 7, { total: 999 });
db.store.add<Partial<Order>>('Order', { customerId: 1, total: 5 });
db.save().subscribe();
```

Query operators compose with RxJS `pipe` too, since each one is a unary function:

```ts
import { pipe } from 'rxjs';
const recent = pipe(where<Order>(gt('total', 100)), order<Order>('total', 'desc'));
const q = recent(query<Order>('Order'));
```

## Breeze name map

Breeze's vocabulary, and what it became here.

| Breeze 1.x | rxjs-breeze |
| --- | --- |
| `EntityQuery.from('Customers').where('name', 'startsWith', 'A')` | `query<Customer>('Customer', where(starts('name', 'A')))` |
| `.orderBy('name desc').skip(10).take(5).inlineCount()` | `order('name', 'desc'), skip(10), take(5), count()` |
| `.expand('orders')`, `.select('id,name')` | `expand('orders')`, `pick('id', 'name')` |
| `Predicate.create(...).and(...).or(...).not()` | `and(...)`, `or(...)`, `not(...)` |
| `'any'` / `'all'` predicates | `any('orders', gt('total', 100))`, `all(...)` |
| Predicate visitors (`toJSON`, `toFunction`, `toODataFragment`) | `toJson`, `toFn`, `toFilter` / `toOData` |
| `uriBuilder` adapter (`odata`, `json`) | `http(base, { url: toOData })` or a `url` built from `toJson` |
| `dataService` adapter (`webApi`, `odata`, `mongo`) | `Provider`: `http`, `memory`, or your own |
| `ajax` adapter | the `fetch` option of `http` |
| `modelLibrary` adapter (`ko`, `backbone`, `backingStore`) | RxJS: `store.watch`, `state$`, `changes$` |
| `EntityManager` | `store` |
| `executeQuery` / `executeQueryLocally` | `client.fetch` / `store.run`, `store.watch` |
| `FetchStrategy.FromServer` / `FromLocalCache` | `fetch(q, { from: 'remote' \| 'local' \| 'localFirst' })` |
| `MergeStrategy.PreserveChanges` / `OverwriteChanges` / `SkipMerge` | `{ merge: 'keep' \| 'overwrite' \| 'skip' }` |
| `createEntity` / `attachEntity` / `detachEntity` | `store.add` / `attach` / `detach` |
| `entity.setProperty(...)` / `entityAspect.setDeleted()` | `store.patch` / `store.remove` |
| `EntityState.Added` / `Modified` / `Deleted` / `Unchanged` | `Row.state`: `'added'` / `'changed'` / `'removed'` / `'clean'` |
| `entityAspect.originalValues` | `Row.orig` |
| `getChanges` / `hasChanges` / `rejectChanges` | `store.changes` / `changes$` / `store.revert` |
| `saveChanges` | `client.save` |
| `exportEntities` / `importEntities` | `store.snapshot` / `store.restore` |
| `MetadataStore` / `EntityType` / `NavigationProperty` | `schema({ Type: { key, props, navs } })` |
| `KeyGenerator` temporary keys | negative numbers (or `tmp_n`) from `add`, replaced by `accept` after save |
| `entityChanged` / `hasChangesChanged` events | `state$` / `changes$` |

## Layers

```
src/pred.ts, query.ts     queries as data: predicate tree, query value, operators
src/interp/               interpreters: fn (local), odata and json (wire)
src/cache.ts              the pure core: Cache -> Cache functions, no state
src/store.ts              the reactive shell: one BehaviorSubject around the cache
src/provider.ts           Provider and Client: fetch merges, save accepts
src/providers/            memory (in-process server) and http
```

Rules the code follows:

- Public generics are `T extends object`, so plain interfaces work as entity types.
- Property paths are `keyof T` with autocomplete, but any dotted string is accepted (`'customer.city'`).
- Everything in `cache.ts` is a pure function; the store only applies them and emits.
- Incoming data with nested navigations is normalized into one row per entity. Navigations are filled back in on read along `expand` paths, and resolved on the fly when a filter or ordering uses one.

## Writing a provider

```ts
import type { Provider } from 'rxjs-breeze';

const mine: Provider = {
  query: (q) => /* Observable<{ rows, count? }> */,
  save: (rows) => /* Observable<{ rows: [{ type, data, was? }], removed?: [{ type, key }] }> */,
};
```

`was` tells the store which temporary key a saved entity had, so foreign keys pointing at it are rewritten.

## Scope

In this first version: queries, three interpreters, the identity-map cache with change tracking and live local queries, fetch and merge strategies, temporary keys with foreign-key fix-up, snapshots, an in-memory provider and an OData-flavoured HTTP provider.

Not yet: validation rules, complex types, inheritance, server metadata (`$metadata` or Breeze metadata JSON), naming conventions, case-insensitive local comparison, and a reference server for the JSON wire format. Open an issue if one of these matters to you.

## Acknowledgements

The design is derived from Breeze.js by IdeaBlade, released under the MIT license. rxjs-breeze is an independent reimplementation and is not affiliated with IdeaBlade.

## License

MIT
