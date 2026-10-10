import { describe, expect, it } from 'vitest';
import { run } from '../src/interp/fn';
import { fromJson, toJson } from '../src/interp/json';
import { toFilter, toOData } from '../src/interp/odata';
import { and, any, eq, ge, gt, not, oneOf, starts } from '../src/pred';
import { count, expand, order, pick, query, skip, take, where } from '../src/query';
import { orders, type Order } from './fixtures';

describe('toFilter', () => {
  it('renders comparisons, functions and nesting', () => {
    expect(toFilter(and(eq('city', "O'Reilly"), gt('total', 5)))).toBe("(city eq 'O''Reilly' and total gt 5)");
    expect(toFilter(starts('name', 'A'))).toBe("startswith(name,'A')");
    expect(toFilter(not(eq('active', true)))).toBe('not (active eq true)');
    expect(toFilter(oneOf('id', [1, 2]))).toBe('(id eq 1 or id eq 2)');
    expect(toFilter(eq('customer.city', 'Berlin'))).toBe("customer/city eq 'Berlin'");
    expect(toFilter(any('orders', gt('total', 100)))).toBe('orders/any(x: x/total gt 100)');
    expect(toFilter(any('orders', any('lines', ge('qty', 2))))).toBe('orders/any(x: x/lines/any(y: y/qty ge 2))');
    expect(toFilter(eq('placed', new Date('2024-01-05T00:00:00.000Z')))).toBe('placed eq 2024-01-05T00:00:00.000Z');
  });
});

describe('toOData', () => {
  it('renders a full url', () => {
    const q = query<Order>(
      'Order',
      where(gt('total', 50)),
      order('placed', 'desc'),
      skip(10),
      take(5),
      expand('customer'),
      pick('id', 'total'),
      count(),
    );
    expect(decodeURIComponent(toOData(q))).toBe(
      'Order?$filter=total gt 50&$orderby=placed desc&$skip=10&$top=5&$expand=customer&$select=id,total&$count=true',
    );
    expect(toOData(query('Order'))).toBe('Order');
  });
});

describe('json', () => {
  it('round-trips a query with dates', () => {
    const q = query<Order>('Order', where(ge('placed', new Date('2024-02-01T00:00:00.000Z'))), take(3));
    const back = fromJson<Order>(toJson(q));
    expect(back).toEqual(q);
    expect(run(back, orders).map((o) => o.id)).toEqual([11, 12]);
  });

  it('rejects non-queries', () => {
    expect(() => fromJson('{"nope":1}')).toThrow();
  });
});
