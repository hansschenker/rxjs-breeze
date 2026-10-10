/**
 * Validation rules: pure functions from a value to an error message or null.
 * Rules attach to a schema type under `rules` (per property) or `checks`
 * (whole entity) and run through `validate`.
 */
import type { Kind } from './schema';

export interface Ctx<T extends object = object> {
  readonly type: string;
  /** Property being checked, or null for entity-level checks. */
  readonly path: string | null;
  readonly entity: T;
}

export interface Rule<T extends object = object, V = unknown> {
  readonly name: string;
  /** Returns an error message, or null when the value is acceptable. */
  check(value: V, ctx: Ctx<T>): string | null;
}

/** Build a rule from a name and a check function. */
export const rule = <T extends object = object, V = unknown>(
  name: string,
  check: (value: V, ctx: Ctx<T>) => string | null,
): Rule<T, V> => ({ name, check });

const label = (ctx: Ctx): string => ctx.path ?? ctx.type;
const at = (v: number | Date): number => (typeof v === 'number' ? v : v.getTime());
const time = (v: unknown): number | null =>
  typeof v === 'number' ? v : v instanceof Date ? v.getTime() : null;
const show = (v: number | Date): string => (v instanceof Date ? v.toISOString() : String(v));

/** Fails on null and undefined, and on the empty string unless `allowEmpty` is set. */
export const required = (allowEmpty = false): Rule =>
  rule('required', (v, ctx) =>
    v == null || (!allowEmpty && v === '') ? `${label(ctx)} is required` : null,
  );

export const maxLen = (n: number): Rule =>
  rule('maxLen', (v, ctx) =>
    typeof v === 'string' && v.length > n ? `${label(ctx)} must be at most ${n} characters` : null,
  );

export const minLen = (n: number): Rule =>
  rule('minLen', (v, ctx) =>
    typeof v === 'string' && v.length < n ? `${label(ctx)} must be at least ${n} characters` : null,
  );

/** Lower bound for numbers and dates; null passes. */
export const min = (lo: number | Date): Rule =>
  rule('min', (v, ctx) => {
    const x = time(v);
    return x !== null && x < at(lo) ? `${label(ctx)} must be at least ${show(lo)}` : null;
  });

/** Upper bound for numbers and dates; null passes. */
export const max = (hi: number | Date): Rule =>
  rule('max', (v, ctx) => {
    const x = time(v);
    return x !== null && x > at(hi) ? `${label(ctx)} must be at most ${show(hi)}` : null;
  });

export const range = (lo: number | Date, hi: number | Date): Rule =>
  rule('range', (v, ctx) => {
    const x = time(v);
    return x !== null && (x < at(lo) || x > at(hi))
      ? `${label(ctx)} must be between ${show(lo)} and ${show(hi)}`
      : null;
  });

export const int = (): Rule =>
  rule('int', (v, ctx) =>
    typeof v === 'number' && !Number.isInteger(v) ? `${label(ctx)} must be a whole number` : null,
  );

/** Strings must match `re`; null and the empty string pass (combine with `required`). */
export const pattern = (re: RegExp, what = 'value'): Rule =>
  rule('pattern', (v, ctx) =>
    typeof v === 'string' && v !== '' && !re.test(v) ? `${label(ctx)} is not a valid ${what}` : null,
  );

export const email = (): Rule => ({ ...pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'email address'), name: 'email' });

export const url = (): Rule => ({ ...pattern(/^https?:\/\/\S+$/i, 'URL'), name: 'url' });

/** Type check matching a schema `Kind`; null and undefined pass. Applied automatically from `props`. */
export const ofKind = (k: Kind): Rule =>
  rule('kind', (v, ctx) => {
    if (v == null) return null;
    const ok =
      k === 'string'
        ? typeof v === 'string'
        : k === 'number'
          ? typeof v === 'number' && Number.isFinite(v)
          : k === 'boolean'
            ? typeof v === 'boolean'
            : v instanceof Date && !Number.isNaN(v.getTime());
    return ok ? null : `${label(ctx)} must be a ${k}`;
  });
