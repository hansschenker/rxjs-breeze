export type Kind = 'string' | 'number' | 'boolean' | 'date';

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

export interface Type {
  readonly key: string | readonly string[];
  readonly props?: Readonly<Record<string, Kind>>;
  readonly navs?: Readonly<Record<string, Nav>>;
}

export type Schema = Readonly<Record<string, Type>>;

/** Identity helper that keeps literal types. */
export const schema = <S extends Schema>(s: S): S => s;

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

export const keyProps = (s: Schema, name: string): readonly string[] => {
  const k = def(s, name).key;
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

export const keyKind = (s: Schema, name: string): Kind => {
  const [first] = keyProps(s, name);
  return (first && def(s, name).props?.[first]) || 'number';
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
