import type { Pred, Scalar } from '../pred';
import type { Query } from '../query';

const lit = (v: Scalar): string => {
  if (v === null) return 'null';
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  if (v instanceof Date) return v.toISOString();
  return String(v);
};

const seg = (path: string): string => path.replace(/\./g, '/');

const vars = ['x', 'y', 'z'];

/** Render a predicate as an OData v4 `$filter` expression. */
export const toFilter = <T>(p: Pred<T>, prefix = '', depth = 0): string => {
  switch (p.op) {
    case 'and':
    case 'or':
      return `(${p.preds.map((x) => toFilter(x, prefix, depth)).join(` ${p.op} `)})`;
    case 'not':
      return `not (${toFilter(p.pred, prefix, depth)})`;
    case 'in':
      return `(${p.values.map((v) => `${prefix}${seg(p.path)} eq ${lit(v)}`).join(' or ')})`;
    case 'any':
    case 'all': {
      const v = vars[depth] ?? `v${depth}`;
      return `${prefix}${seg(p.path)}/${p.op}(${v}: ${toFilter(p.pred, `${v}/`, depth + 1)})`;
    }
    case 'has':
      return `contains(${prefix}${seg(p.path)},${lit(p.value)})`;
    case 'starts':
      return `startswith(${prefix}${seg(p.path)},${lit(p.value)})`;
    case 'ends':
      return `endswith(${prefix}${seg(p.path)},${lit(p.value)})`;
    default:
      return `${prefix}${seg(p.path)} ${p.op} ${lit(p.value)}`;
  }
};

/** Render a query as an OData v4 resource path with query options: the remote interpreter. */
export const toOData = (q: Query): string => {
  const parts: string[] = [];
  const add = (k: string, v: string): void => {
    parts.push(`${k}=${encodeURIComponent(v)}`);
  };
  if (q.where) add('$filter', toFilter(q.where));
  if (q.order.length > 0) {
    add('$orderby', q.order.map((o) => `${seg(o.path)}${o.desc ? ' desc' : ''}`).join(','));
  }
  if (q.skip) add('$skip', String(q.skip));
  if (q.take != null) add('$top', String(q.take));
  if (q.expand.length > 0) add('$expand', q.expand.map((e) => seg(e)).join(','));
  if (q.pick) add('$select', q.pick.map((e) => seg(e)).join(','));
  if (q.count) add('$count', 'true');
  for (const [k, v] of Object.entries(q.params)) add(k, v instanceof Date ? v.toISOString() : String(v));
  return parts.length > 0 ? `${q.type}?${parts.join('&')}` : q.type;
};
