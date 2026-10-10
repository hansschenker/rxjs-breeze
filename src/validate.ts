/**
 * Validation is derived, never stored: `validate` turns an entity into a list
 * of issues, `issues` does it for every pending row of a cache. The store
 * exposes both, and `client.save` refuses invalid rows.
 */
import { type Cache, dirty, row } from './cache';
import { type Rule, ofKind } from './rules';
import { type Key, type Schema, def, hasKey, keyOf, props } from './schema';

export interface Issue {
  readonly type: string;
  readonly key: Key | null;
  /** Property the issue is about, or null for entity-level checks. */
  readonly path: string | null;
  readonly rule: string;
  readonly message: string;
}

/**
 * Validate one entity: kind checks from `props`, then `rules` per property,
 * then entity `checks`. Pass `only` to check some properties and skip the
 * entity checks.
 */
export const validate =
  (s: Schema) =>
  <T extends object>(t: string, data: T, only?: readonly string[]): Issue[] => {
    const d = def(s, t);
    const key = hasKey(s, t, data) ? keyOf(s, t, data) : null;
    const pd = props(data);
    const names = only ?? [...new Set([...Object.keys(d.props ?? {}), ...Object.keys(d.rules ?? {})])];
    const out: Issue[] = [];
    const push = (path: string | null, r: Rule, value: unknown): void => {
      const message = r.check(value, { type: t, path, entity: data });
      if (message) out.push({ type: t, key, path, rule: r.name, message });
    };
    for (const path of names) {
      const k = d.props?.[path];
      if (k) push(path, ofKind(k), pd[path]);
      for (const r of d.rules?.[path] ?? []) push(path, r, pd[path]);
    }
    if (!only) for (const r of d.checks ?? []) push(null, r, data);
    return out;
  };

/** Issues for pending rows (added or changed), or for one entity regardless of its state. */
export const issues =
  (s: Schema) =>
  (c: Cache, t?: string, key?: Key): Issue[] => {
    if (t !== undefined && key !== undefined) {
      const r = row(c, t, key);
      return r && r.state !== 'removed' ? validate(s)(t, r.data) : [];
    }
    return dirty(c)
      .filter((r) => r.state !== 'removed' && (t === undefined || r.type === t))
      .flatMap((r) => validate(s)(r.type, r.data));
  };

/** The error a save fails with when rows are invalid. */
export interface Invalid extends Error {
  readonly issues: readonly Issue[];
}

export const invalid = (found: readonly Issue[]): Invalid =>
  Object.assign(
    new Error(
      `rxjs-breeze: ${found.length} validation issue${found.length === 1 ? '' : 's'}: ${found
        .map((i) => i.message)
        .join('; ')}`,
    ),
    { name: 'Invalid', issues: found },
  );

export const isInvalid = (e: unknown): e is Invalid =>
  e instanceof Error && e.name === 'Invalid' && 'issues' in e;
