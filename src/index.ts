// Queries as data
export * from './pred';
export * from './query';
export * from './schema';
export { equal } from './eq';

// Interpreters: one query, several executors
export { compare, get, run, toFn } from './interp/fn';
export { toFilter, toOData } from './interp/odata';
export { fromJson, revive, toJson } from './interp/json';

// Validation: rules on the schema, issues derived on demand
export * from './rules';
export * from './validate';

// Pure cache and its reactive shell
export * from './cache';
export * from './store';

// Providers
export * from './provider';
export * from './providers/http';
export * from './providers/memory';
export * from './providers/odata';
