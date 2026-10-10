/**
 * Validation is derived, never stored: `validate` turns an entity into a list
 * of issues, `issues` does it for every pending row of a cache. The store
 * exposes both, and `client.save` refuses invalid rows.
 */
import { type Cache, dirty, row } from './cache';
import { type Rule, ofKind, rule } from './rules';
import { type Key, type Schema, def, hasKey, isComplex, keyOf, propDef, props } from './schema';

export interface Issue {
  readonly type: string;
  readonly key: Key | null;
  /** Dotted path of the property the issue is about ("address.city", "phones.1.number"), or null for entity-level checks. */
  readonly path: string | null;
  readonly rule: string;
  readonly message: string;
}

interface Root {
  readonly type: string;
  readonly key: Key | null;
}

const isObj = (v: unknown): v is object =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

const article = (name: string): string => (/^[aeiou]/i.test(name) ? 'an' : 'a');

const shape = (name: string, many: boolean): Rule =>
  rule('kind', (_, ctx) =>
    `${ctx.path ?? ctx.type} must be ${many ? `a list of ${name}` : `${article(name)} ${name}`}`,
  );

/** Group `only` paths by their first segment; undefined means "everything under it". */
const group = (only?: readonly string[]): Map<string, string[] | undefined> => {
  const m = new Map<string, string[] | undefined>();
  for (const p of only ?? []) {
    const [head = '', ...rest] = p.split('.');
    if (rest.length === 0) m.set(head, undefined);
    else if (!m.has(head) || m.get(head) !== undefined) m.set(head, [...(m.get(head) ?? []), rest.join('.')]);
  }
  return m;
};

const walk = (
  s: Schema,
  t: string,
  data: object,
  prefix: string,
  root: Root,
  only?: readonly string[],
): Issue[] => {
  const d = def(s, t);
  const pd = props(data);
  const groups = group(only);
  const names = only ? [...groups.keys()] : [...new Set([...Object.keys(d.props ?? {}), ...Object.keys(d.rules ?? {})])];
  const out: Issue[] = [];
  const push = (path: string | null, r: Rule, value: unknown): void => {
    const message = r.check(value, { type: t, path, entity: data });
    if (message) out.push({ type: root.type, key: root.key, path, rule: r.name, message });
  };
  for (const name of names) {
    const full = prefix + name;
    const value = pd[name];
    const decl = d.props?.[name];
    const sub = groups.get(name);
    const p = decl === undefined ? undefined : propDef(decl);
    if (p !== undefined && 'kind' in p) {
      push(full, ofKind(p.kind), value);
    } else if (p !== undefined && value != null) {
      if (p.many) {
        if (!Array.isArray(value)) push(full, shape(p.complex, true), value);
        else {
          (value as unknown[]).forEach((v, i) => {
            if (isObj(v)) out.push(...walk(s, p.complex, v, `${full}.${i}.`, root, sub));
            else push(`${full}.${i}`, shape(p.complex, false), v);
          });
        }
      } else if (!isObj(value)) push(full, shape(p.complex, false), value);
      else out.push(...walk(s, p.complex, value, `${full}.`, root, sub));
    }
    if (sub === undefined) for (const r of d.rules?.[name] ?? []) push(full, r, value);
  }
  if (!only) for (const r of d.checks ?? []) push(prefix ? prefix.slice(0, -1) : null, r, data);
  return out;
};

/**
 * Validate one entity: kind checks from `props`, then `rules` per property,
 * then entity `checks`, recursing into complex-typed values. Pass `only`
 * (dotted paths allowed) to check some properties and skip the entity checks.
 */
export const validate =
  (s: Schema) =>
  <T extends object>(t: string, data: T, only?: readonly string[]): Issue[] => {
    const key = !isComplex(s, t) && hasKey(s, t, data) ? keyOf(s, t, data) : null;
    return walk(s, t, data, '', { type: t, key }, only);
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
