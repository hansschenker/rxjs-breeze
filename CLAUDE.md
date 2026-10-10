# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A functional TypeScript + RxJS reimplementation of the ideas in Breeze.js 1.x (the LINQ-provider model: query as data, pluggable executors, an identity-map cache with change tracking). The Breeze name map in README.md is the vocabulary contract: keep names short and lower-case, no classes.

## Commands

```bash
npm test                                   # vitest run
npx vitest run test/store.test.ts          # one file
npx vitest run -t "fixes foreign keys"     # one test by name
npm run typecheck                          # tsc --noEmit (strict + noUncheckedIndexedAccess)
npm run build                              # tsup -> dist/index.js + index.d.ts
npm run example                            # node examples/northwind.mjs against the live Northwind OData service (needs dist)
npm run example:trippin                    # batched writes against the TripPin sandbox (needs dist)
npm run example:json                       # reference JSON server + http client in one process (needs dist)
npm run web                                # Vite dev server for examples/web, a browser demo importing src/ directly
```

Done means typecheck, tests and build all pass. ESM only, npm only (package-lock.json), rxjs is a peer dependency.

The build runs tsup for JavaScript and then `tsc -p tsconfig.build.json` for declarations. Do not switch back to `tsup --dts`: this project uses TypeScript 7 (the native compiler), which lacks the JS API that tsup's declaration plugin needs, and it crashes with `Cannot read properties of undefined (reading 'useCaseSensitiveFileNames')`.

## Architecture

Four layers, each a module boundary; dependencies only point downwards in this list:

1. **Queries as data**: `src/pred.ts` (predicate tree + constructors `eq`, `and`, `any`, ...), `src/query.ts` (`Query<T>` value + operators `where`, `order`, `pick`, `expand`, `take`, ...). Operators are unary `Query -> Query` functions so they compose with `query(type, ...ops)` and RxJS `pipe`.
2. **Interpreters** in `src/interp/`: `fn.ts` compiles a predicate to a JS function and runs a query over an array; `odata.ts` renders OData v4; `json.ts` serializes with Date revival. Adding a wire format means adding an interpreter here, never touching the query types.
3. **Cache**: `src/cache.ts` is pure (`Cache -> Cache` functions: `put`, `patch`, `drop`, `revert`, `merge`, `fill`, `select`, `accept`, snapshots). `src/store.ts` is the only stateful file: one `BehaviorSubject<Cache>` plus `watch`/`changes$` derived with `distinctUntilChanged`. Put new behaviour in `cache.ts` as a pure function and expose it through the store.
4. **Providers**: `src/provider.ts` defines `Provider` (`query`, `save`) and `client` (fetch merges into the store, save calls `accept`). `src/providers/memory.ts` is an in-process server built on the same cache functions; `src/providers/http.ts` is GET-by-URL plus POST-save; `src/providers/odata.ts` reuses `http` for reads and writes either one OData request per row or one `$batch` changeset (`batch: 'multipart' | 'json'`), binding children of same-batch parents with `nav@odata.bind: "$n"`. `src/providers/batch.ts` builds and parses both batch formats as pure functions. `src/providers/keys.ts` holds what every writing provider needs: temp-to-real key map, foreign-key remap, dependency ordering (`topo`).

**Validation** sits beside the cache: `src/rules.ts` has `Rule`/`Ctx` and the built-in rule constructors; `src/validate.ts` derives `Issue[]` from a type's `props` kinds, `rules` and `checks`. Issues are never stored. The store computes them on demand (`issues`, `issues$`) and `client.save` errors with `invalid(issues)` unless called with `{ validate: false }`.

5. **Server**: `src/server.ts` is a second tsup entry published as `rxjs-breeze/server` and the only file allowed to import `node:*`. `handle(provider)` is a framework-free request handler for the JSON wire format (`GET /Type?q=`, `POST /query`, `POST /save`); `serve` wraps it in `node:http`; `persist`/`load` keep a `memory` provider's rows in a file. Never import it from `src/index.ts`, which must stay browser-safe.

Conventions that are easy to break:

- Public generics are `T extends object` (plain interfaces must work). Read properties through `props(x)[k]`, never by casting to `any`.
- A schema type without `key` is a complex (value) type; `props` reference it by name (`'Address'`, `'Phone[]'`), and `schema()` throws on dangling or entity references. Complex values stay inside the parent row: never normalized, merged by `blend` on `patch`, stored whole in `orig`, validated recursively with dotted paths. Structural comparison everywhere goes through `equal` in `src/eq.ts`.
- `fill` is the cache-side navigation loader; `expand` is the query operator. Don't rename one to the other.
- Naming conventions (`src/naming.ts`) apply only at the provider boundary: `http`, `odata` and the server's `handle` rename with `renameQuery` / `renameData` / `renameRow`. The schema, store and cache never see server names, and keys containing `@` are never renamed.
- `select` resolves navigations used by `where`/`order` on the fly and strips them again unless requested by `expand`.
- Temporary keys are negative numbers (or `tmp_n` for string keys). A provider's save result reports `was` for re-keyed rows; `accept` rewrites foreign keys via `fkRefs(schema)`.
- Merge strategy `skip` leaves dirty rows out of the returned result, not just unmerged.

## Tests

Vitest in `test/`; `fixtures.ts` holds the Northwind-style schema and rows every test uses. `memory` is the provider to test against; the `http` tests inject a fake `fetch` through `HttpOpts.fetch`.
