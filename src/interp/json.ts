import type { Query } from '../query';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** JSON reviver that turns ISO date strings back into Dates. */
export const revive = (_key: string, value: unknown): unknown =>
  typeof value === 'string' && ISO.test(value) ? new Date(value) : value;

/** Serialize a query as JSON: the wire format for JSON-speaking servers. Dates become ISO strings. */
export const toJson = (q: Query): string => JSON.stringify(q);

/** Parse a query from JSON, reviving ISO date strings. */
export const fromJson = <T = unknown>(text: string): Query<T> => {
  const raw: unknown = JSON.parse(text, revive);
  if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') {
    throw new Error('rxjs-breeze: not a query');
  }
  const q = raw as Partial<Query<T>> & { readonly type: string };
  return {
    ...q,
    order: q.order ?? [],
    expand: q.expand ?? [],
    count: q.count ?? false,
    params: q.params ?? {},
  };
};
