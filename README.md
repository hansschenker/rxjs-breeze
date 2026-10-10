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

To see it against a real datasource, `examples/northwind.mjs` queries the public Northwind OData v4 service, expands navigations, and re-runs the same query from the cache:

```bash
npm run build && npm run example
```

The same thing as a web page, with editable cells and the cache and pending changes watched live, is `examples/web`. Vite serves it straight from the TypeScript source:

```bash
npm run web
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
| `dataService` adapter (`webApi`, `webApiOData`, `mongo`) | `Provider`: `http`, `odata`, `memory`, or your own |
| OData adapter `$batch` changesets with Content-ID references | `odata(..., { batch: 'multipart' \| 'json' })`, new parents bound with `nav@odata.bind: "$n"` |
| Server packages (`breeze-sequelize`, `breeze-mongodb`, `Breeze.ContextProvider`) | `serve(provider)` from `rxjs-breeze/server`, with `memory` or your own `Provider` |
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
| `Validator.required` / `maxLength` / `stringLength` / `int` / `regex` / `emailAddress` / `url` | `required()` / `maxLen(n)` / `minLen(n)` / `int()` / `pattern(re)` / `email()` / `url()` |
| `DataType` validators (number, date, bool) | `ofKind(kind)`, applied automatically from `props` |
| `new Validator(name, fn)` | `rule(name, (value, ctx) => message \| null)` |
| `DataProperty.validators` / `EntityType.validators` | `rules: { prop: [...] }` / `checks: [...]` on the schema type |
| `entityAspect.validateEntity()` / `getValidationErrors()` | `store.issues(type, key)` / `store.issues()` |
| `validationErrorsChanged` event | `store.issues$` |
| `ValidationOptions.validateOnSave` | `client.save(rows, { validate: false })` to skip |
| `ValidationError` | `Issue`; a refused save errors with `Invalid` (`isInvalid(err)`, `err.issues`) |
| `ComplexType` | a schema type without `key` |
| `DataProperty.isComplexProperty` / `isScalar: false` | `props: { address: 'Address' }` / `props: { phones: 'Phone[]' }` |
| `customer.address.city = 'Bonn'` | `store.patch('Customer', 1, { address: { city: 'Bonn' } })` (merged, not replaced) |
| `complexAspect.originalValues` | `Row.orig` holds the whole previous complex value |

## Layers

```
src/pred.ts, query.ts     queries as data: predicate tree, query value, operators
src/interp/               interpreters: fn (local), odata and json (wire)
src/rules.ts, validate.ts validation: rule constructors, issues derived from schema + entity
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

## Complex types

A schema type without a `key` is a complex type: a value stored inside its parent, with no identity of its own. Reference it by name in `props`, with `[]` for a list:

```ts
const nw = schema({
  Customer: {
    key: 'id',
    props: { id: 'number', name: 'string', address: 'Address', phones: 'Phone[]' },
  },
  Address: { props: { street: 'string', city: 'string', zip: 'string' }, rules: { city: [required()] } },
  Phone: { props: { kind: 'string', number: 'string' } },
});
```

Complex values are never normalized; they travel with their entity. Everything else just works on dotted paths:

- Queries: `where(eq('address.city', 'Berlin'))` runs locally and renders as `address/city eq 'Berlin'` in OData. Lists take `any('phones', starts('number', '+49'))`.
- Patches merge: `store.patch('Customer', 1, { address: { city: 'Bonn' } })` keeps `street` and `zip`. Lists and dates are replaced whole. `Row.orig` records the whole previous value, so `revert` restores it.
- Validation recurses: issues come back with paths like `address.city` or `phones.1.number`, and a wrong shape reports `address must be an Address`.

## Validation

Rules are pure functions attached to the schema. Kind checks come from `props` for free; add `rules` per property and `checks` for the whole entity:

```ts
import { email, maxLen, min, required, rule, schema } from 'rxjs-breeze';

const nw = schema({
  Customer: {
    key: 'id',
    props: { id: 'number', name: 'string', email: 'string' },
    rules: { name: [required(), maxLen(40)], email: [email()] },
  },
  Order: {
    key: 'id',
    props: { id: 'number', customerId: 'number', total: 'number', placed: 'date' },
    rules: { total: [min(0)] },
    checks: [
      rule<Order>('not-future', (_, { entity }) =>
        entity.placed.getTime() > Date.now() ? 'placed cannot be in the future' : null,
      ),
    ],
  },
});
```

Issues are derived, never stored. `store.issues()` validates the pending rows now, `store.issues$` streams them as they change, and `client.save` refuses to send invalid rows by erroring with an `Invalid` that carries the `issues`. Pass `{ validate: false }` to skip the check.

```ts
db.store.issues$.subscribe((issues) => showErrors(issues));
db.save().subscribe({ error: (e) => (isInvalid(e) ? showErrors(e.issues) : rethrow(e)) });
```

## Providers

| Provider | Reads | Writes |
| --- | --- | --- |
| `memory(schema, seed)` | compiled-function interpreter over an in-process cache | assigns real keys, fixes foreign keys |
| `http(base, opts)` | GET by URL, OData by default, the JSON format with `url: toJsonUrl` | POSTs the whole change set to one `save` endpoint, as the reference server expects |
| `odata(schema, base, { sets, batch })` | GET, OData v4, with type-to-entity-set mapping | `POST` for added rows (parents before the children that reference them), `PATCH` with the changed properties, `DELETE` children first; one request per row, or one atomic `$batch` changeset |
| `serve(provider)` from `rxjs-breeze/server` | the other side: any provider exposed over HTTP in the JSON format | `POST /save` forwarded to the provider |

`odata` strips temporary keys from `POST` bodies, reads the real key from the response, and rewrites foreign keys of later requests to it. With `batch: 'multipart'` (OData 4.0) or `batch: 'json'` (OData 4.01) a save is one changeset that the server applies completely or not at all; a child of an entity created in the same changeset is bound to it by Content-ID (`"customer@odata.bind": "$1"`), which needs the child's navigation declared in the schema. Without `batch`, requests run one by one and a failure mid-way leaves the earlier ones applied. `examples/trippin.mjs` runs batched create, patch, delete and read-back round trips against the public TripPin sandbox:

```bash
npm run build && npm run example:trippin
```

## Reference JSON server

Any `Provider` can be served over HTTP with the Node-only entry `rxjs-breeze/server`. It speaks the JSON wire format the `http` client provider produces with `url: toJsonUrl`, so a JSON backend needs no OData and no query parser of its own:

```ts
import { client, http, memory, store, toJsonUrl } from 'rxjs-breeze';
import { serve } from 'rxjs-breeze/server';

const running = await serve(memory(nw, seed), { port: 3000 }); // any Provider; memory is the reference backend
const db = client(store(nw), http(running.url, { url: toJsonUrl })); // the client side
```

| Request | Response |
| --- | --- |
| `GET {base}/{Type}?q={toJson(query)}` | `{ rows, count? }` |
| `GET {base}/{Type}` | every row of `Type` |
| `POST {base}/query`, body: the query JSON | `{ rows, count? }` |
| `POST {base}/save`, body: `{ rows: Row[] }` | `{ rows: [{ type, data, was? }], removed: [{ type, key }] }` |

Dates travel as ISO strings and are revived on both sides. Errors are `{ error: { message } }` with 400 for bad input, 404 for unknown routes, 500 otherwise. CORS headers are on by default (`cors: false` turns them off), and `handle(provider)` gives you the request handler without `node:http` for use inside another framework.

To back it with a database, implement the two-method `Provider` against your query builder (an interpreter from `Pred` to a `where` clause is the same visitor shape as `toFilter`) and pass it to `serve`. For prototypes, `persist(file, memoryProvider, schema)` rewrites a JSON file after every save and `load(file)` reads it back as the seed. `examples/json.mjs` runs server and client in one process:

```bash
npm run build && npm run example:json
```

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

In this version: queries, three interpreters, the identity-map cache with change tracking and live local queries, fetch and merge strategies, temporary keys with foreign-key fix-up, snapshots, complex types, validation rules with save-time enforcement, an in-memory provider, an HTTP provider for JSON servers, an OData v4 provider that reads and writes, per request or as one atomic `$batch` changeset, and a reference JSON server that exposes any provider over HTTP.

Not yet: inheritance, server metadata (`$metadata` or Breeze metadata JSON), naming conventions, and case-insensitive local comparison. Open an issue if one of these matters to you.

## Acknowledgements

The design is derived from Breeze.js by IdeaBlade, released under the MIT license. rxjs-breeze is an independent reimplementation and is not affiliated with IdeaBlade.

## License

MIT
