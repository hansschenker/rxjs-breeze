# Roadmap

Where rxjs-breeze stands after its first day, and the milestones to finish the Breeze.js feature set in a modern, functional shape. Each milestone has a goal, the work, what "done" means, and a rough size (S: an afternoon, M: a day or two, L: a week).

## Done (v0.1, October 2026)

Queries as data with three interpreters (local function, OData v4, JSON); schema with keys, navigations, complex types, validation rules; pure identity-map cache with change tracking, merge strategies, navigation fill, temporary keys, snapshots; reactive store with live `watch` and `issues$`; providers `memory`, `http`, `odata` (reads, per-row writes, `$batch` in both formats); reference JSON server `rxjs-breeze/server` with persistence; naming conventions at the wire; examples for Northwind, TripPin, the JSON server and a Vite browser page. 75 tests.

## M1. Ship v0.1.0 (S)

Goal: installable from npm with confidence.

- [ ] GitHub Actions: typecheck, test, build on push and PR, Node 22 and 24.
- [ ] `prettier --check` in CI (config exists, formatting not yet enforced).
- [ ] Verify the package: `npm pack --dry-run`, `publint`, `@arethetypeswrong/cli` for the two entries.
- [ ] CHANGELOG.md, version bump, `npm publish --access public`.
- [ ] README: npm badge, link to this roadmap.

Done when: a fresh project can `npm i rxjs-breeze rxjs` and run the Quick start against Northwind.

## M2. Query completeness (M)

Goal: close the gaps between the local and remote interpreters, and the last Breeze query options.

- [ ] Case-insensitive local comparison, Breeze's `LocalQueryComparisonOptions`: `toFn(pred, { ci: true })`, a `store(schema, { ci })` option, default matching SQL Server-style servers.
- [ ] `fetchByKey(type, key, { from })` on the client, Breeze's `fetchEntityByKey` with `checkLocalCacheFirst`.
- [ ] `pick` on nested paths returns nested objects, or document the flat shape; decide once.
- [ ] OData nested expand options: `expand('orders', { take: 5, order: ... })` rendering `$expand=Orders($top=5;$orderby=...)`, and the local equivalent in `fill`.
- [ ] Scalar kinds beyond the four: `'guid'`, `'decimal'` (string on the wire), `'dateOnly'`, `'time'`, with OData literal rendering and validation.
- [ ] `params` semantics for the JSON server (currently passed through and ignored by `memory`).

Done when: every operator has a test for all three interpreters and the README table of operators is complete.

## M3. Server metadata (L)

Goal: build a schema from what the server already publishes, so OData users write no schema by hand.

- [ ] `fromCsdl(xml)`: OData `$metadata` (CSDL) to `Schema`: entity sets, keys, property kinds, navigations with referential constraints, complex types. Fetch helper `odata(...).schema()`.
- [ ] `fromBreeze(json)`: Breeze 1.x metadata JSON to `Schema`, including validators to rules, for migrating existing Breeze apps.
- [ ] `GET /schema` on the reference server and `http(...).schema()` on the client; rules are not serialized, only shape.
- [ ] Northwind and TripPin examples switch to fetched metadata.

Done when: `examples/northwind.mjs` runs with no hand-written schema and the CSDL parser is tested against Northwind's and TripPin's real `$metadata` documents, stored as fixtures.

## M4. Inheritance (M)

Deferred by decision; needed only for backends that expose type hierarchies (EF TPH/TPT through OData).

- [ ] `extends` on schema types; `resolve(schema)` flattens props, navs, rules and checks down the chain.
- [ ] Discriminator: `@odata.type` on the wire, a `kind` property for JSON servers; `merge` tags rows with the concrete type.
- [ ] One cache group per root type; `query('Fruit')` filters subtypes locally and renders a cast segment (`Produce/Model.Fruit`) in OData; `get('Produce', 7)` finds a Fruit.
- [ ] Port the semantics of the old `inheritProduceTests` and `inheritBillingTests` as the conformance suite.

Done when: those two suites pass against `memory` and against a fake OData server emitting `@odata.type`.

## M5. Store ergonomics and concurrency (M)

Goal: the things real apps ask for after the first screen works.

- [ ] `store.watchOne(type, key)`, `hasChanges$`, and a `saving$` state on the client.
- [ ] Optimistic concurrency: `concurrency: 'etag' | 'prop'` per type; `@odata.etag` kept per row and sent as `If-Match`; a version property compared on save for JSON servers.
- [ ] Save pipeline hooks on the client: `before(rows)` and `after(saved)` for stamping audit fields or confirming deletes.
- [ ] Offline draft: `snapshot` to IndexedDB or localStorage with a `restore` on startup, as a documented pattern plus a helper.
- [ ] Framework recipes, not adapters: Angular signals via `toSignal(store.watch(q))`, Vue `useObservable`, Solid `from`, each as an example page.

Done when: an edit survives a reload and a stale save is rejected with a clear error in a test.

## M6. Database-backed providers (L)

Goal: the reference server with a real database behind it, outside the core package.

- [ ] A separate package, e.g. `rxjs-breeze-kysely`: an interpreter from `Pred` to a `where` clause plus order, skip, take, count and expand through joins; `Provider.save` as one transaction with key fix-up. The core stays dependency-free.
- [ ] Server-side validation in `handle`: run `validate` before `provider.save`, answer 400 with the issues.
- [ ] Request context: `headers` as a function of the request, `onError`, auth examples.
- [ ] Conformance: the client test suite runs unchanged against `memory`, the JSON server over `memory`, and the Kysely provider over SQLite.

Done when: the conformance run is green for all three backends in CI.

## M7. Documentation and samples (M)

- [ ] Docs site with VitePress: guide (the four layers), the Breeze migration guide built from the name map, cookbook, API reference generated from TSDoc with typedoc.
- [ ] Browser demo gains a provider switch (Northwind OData, JSON server, memory) and a save flow against the JSON server.
- [ ] A conformance suite distilled from the old breeze.js tests (`queryTests`, `saveTests`, `entityTests`) in rxjs-breeze vocabulary, so behaviour stays aligned with the original where it matters.

## Suggested order

M1 first, so people can install it. M2 and M5 next, since they are what apps hit first and are both medium. M3 before M4: fetched metadata is useful to every OData user, inheritance to few. M6 and M7 last, as they build on a stable core.

## Principles to keep

- Query and schema stay plain data; new capabilities are new interpreters or new providers, never new methods on the query.
- `cache.ts` stays pure; the store only applies and emits.
- Short lower-case names; the README name map is the vocabulary contract.
- Every feature lands with tests against `memory` and, where it touches the wire, a fake server test plus a live example when a public service allows it.
