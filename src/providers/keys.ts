/**
 * Helpers shared by providers that play the server's part of a save:
 * remembering which temporary keys became which real keys, rewriting
 * foreign keys that pointed at them, and ordering rows by dependency.
 */
import type { Row } from '../cache';
import { type Data, type FkRef, type Key, asKey, keyId, props, sameKey } from '../schema';

/** Map key for a (type, key) pair. */
export const ref = (t: string, key: Key): string => `${t}:${keyId(key)}`;

/** Replace foreign keys of a `t` entity that point at re-keyed rows. */
export const remap = (refs: readonly FkRef[], keyed: ReadonlyMap<string, Key>, t: string, data: Data): Data =>
  refs
    .filter((x) => x.type === t)
    .reduce((d, x) => {
      const fk = asKey(d[x.fk]);
      const real = fk === undefined ? undefined : keyed.get(ref(x.to, fk));
      return real === undefined ? d : { ...d, [x.fk]: real };
    }, data);

/** True when row `a` holds a foreign key pointing at row `b`. */
export const pointsAt = (refs: readonly FkRef[], a: Row, b: Row): boolean =>
  refs.some((x) => {
    if (x.type !== a.type || x.to !== b.type) return false;
    const fk = asKey(props(a.data)[x.fk]);
    return fk !== undefined && sameKey(fk, b.key);
  });

/** Order items so that each comes after everything it depends on (`dependsOn(a, b)`: a needs b first). */
export const topo = <R>(items: readonly R[], dependsOn: (a: R, b: R) => boolean): R[] => {
  const out: R[] = [];
  const left = [...items];
  while (left.length > 0) {
    const i = left.findIndex((a) => !left.some((b) => b !== a && dependsOn(a, b)));
    if (i < 0) throw new Error('rxjs-breeze: circular dependency between pending rows');
    out.push(...left.splice(i, 1));
  }
  return out;
};
