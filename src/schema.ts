import type { Rule } from './rules';

export type Kind = 'string' | 'number' | 'boolean' | 'date';

/** A property declaration: a scalar kind, or the name of a complex type (`'Address'`, or `'Phone[]'` for a list). */
export type Prop = Kind | (string & {});

/**
 * A navigation property. `fk` always names the foreign-key property on the
 * "many" side: for `many: true` it lives on the target type, otherwise on the
 * declaring type.
 */
export interface Nav {
  readonly to: string;
  readonly fk: string;
  readonly many?: boolean;
}

/**
 * An entity type (has a `key`) or a complex type (no key: a value stored
 * inside its parent entity, with no identity of its own).
 */
export interface Type {
  readonly key?: string | readonly string[];
  readonly props?: Readonly<Record<string, Prop>>;
  readonly navs?: Readonly<Record<string, Nav>>;
  /** Property rules, keyed by property name. */
  readonly rules?: Readonly<Record<string, readonly Rule[]>>;
  /** Entity-level rules; they receive the whole entity. */
  readonly checks?: readonly Rule[];
}

export type Schema = Readonly<Record<string, Type>>;

const KINDS: readonly string[] = ['string', 'number', 'boolean', 'date'];
export const isKind = (p: string): p is Kind => KINDS.includes(p);

export type PropDef = { readonly kind: Kind } | { readonly complex: string; readonly many: boolean };

/** Resolve a property declaration. */
export const propDef = (p: Prop): PropDef =>
  isKind(p)
    ? { kind: p }
    : p.endsWith('[]')
      ? { complex: p.slice(0, -2), many: true }
      : { complex: p, many: false };

/** Check a schema's references and keep its literal types. */
export const schema = <S extends Schema>(s: S): S => {
  for (const [t, d] of Object.entries(s)) {
    if (d.key === undefined && Object.keys(d.navs ?? {}).length > 0) {
      throw new Error(`rxjs-breeze: complex type "${t}" cannot have navigations`);
    }
    for (const [p, decl] of Object.entries(d.props ?? {})) {
      const pd = propDef(decl);
      if ('kind' in pd) continue;
      const target = s[pd.complex];
      if (!target) throw new Error(`rxjs-breeze: ${t}.${p} refers to unknown type "${pd.complex}"`);
      if (target.key !== undefined) {
        throw new Error(`rxjs-breeze: ${t}.${p} refers to entity type "${pd.complex}"; use navs for entities`);
      }
    }
  }
  return s;
};

export type Key = string | number | readonly (string | number)[];

/** Loose view of an entity for property access. */
export type Data = Record<string, unknown>;
export const props = (o: object): Data => o as Data;

/** The definition of a type, or an error naming the unknown type. */
export const def = (s: Schema, name: string): Type => {
  const t = s[name];
  if (!t) throw new Error(`rxjs-breeze: unknown type "${name}"`);
  return t;
};

export const isComplex = (s: Schema, name: string): boolean => def(s, name).key === undefined;

export const keyProps = (s: Schema, name: string): readonly string[] => {
  const k = def(s, name).key;
  if (k === undefined) throw new Error(`rxjs-breeze: "${name}" is a complex type and has no key`);
  return typeof k === 'string' ? [k] : k;
};

const part = (v: unknown, name: string, prop: string): string | number => {
  if (typeof v === 'string' || typeof v === 'number') return v;
  throw new Error(`rxjs-breeze: ${name}.${prop} must be a string or number key, got ${String(v)}`);
};

export const keyOf = (s: Schema, name: string, data: object): Key => {
  const ps = keyProps(s, name);
  const [first] = ps;
  const d = props(data);
  if (ps.length === 1 && first) return part(d[first], name, first);
  return ps.map((p) => part(d[p], name, p));
};

export const hasKey = (s: Schema, name: string, data: object): boolean =>
  keyProps(s, name).every((p) => props(data)[p] != null);

/** Stable string form of a key, used as the cache map key. */
export const keyId = (key: Key): string =>
  typeof key === 'object' ? JSON.stringify(key) : String(key);

export const sameKey = (a: Key, b: Key): boolean => keyId(a) === keyId(b);

export const asKey = (v: unknown): Key | undefined =>
  typeof v === 'string' || typeof v === 'number' ? v : undefined;

/** Kind of the (single) key property; string keys get string temporary keys. */
export const keyKind = (s: Schema, name: string): Kind => {
  const [first] = keyProps(s, name);
  return first !== undefined && def(s, name).props?.[first] === 'string' ? 'string' : 'number';
};

/** A (type, fk, to) triple: `type` holds a foreign key `fk` pointing at `to`. */
export interface FkRef {
  readonly type: string;
  readonly fk: string;
  readonly to: string;
}

export const fkRefs = (s: Schema): FkRef[] => {
  const seen = new Set<string>();
  const out: FkRef[] = [];
  const add = (r: FkRef): void => {
    const id = `${r.type}.${r.fk}->${r.to}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(r);
  };
  for (const [t, d] of Object.entries(s)) {
    for (const nav of Object.values(d.navs ?? {})) {
      if (nav.many) add({ type: nav.to, fk: nav.fk, to: t });
      else add({ type: t, fk: nav.fk, to: nav.to });
    }
  }
  return out;
};
