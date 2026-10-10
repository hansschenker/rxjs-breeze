/**
 * Structural equality for plain data: objects, arrays, dates and scalars.
 * Depth-limited so a malformed graph can never loop.
 */
export const equal = (a: unknown, b: unknown, depth = 8): boolean => {
  if (Object.is(a, b)) return true;
  if (depth === 0 || typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x: unknown, i) => equal(x, b[i], depth - 1))
    );
  }
  const pa = a as Record<string, unknown>;
  const pb = b as Record<string, unknown>;
  const ka = Object.keys(pa);
  return ka.length === Object.keys(pb).length && ka.every((k) => equal(pa[k], pb[k], depth - 1));
};
