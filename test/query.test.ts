import { pipe } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { run, toFn } from '../src/interp/fn';
import { and, any, eq, ge, gt, has, not, oneOf, or, starts } from '../src/pred';
import { order, pick, query, skip, take, where } from '../src/query';
import { alfreds, customers, orders, type Customer, type Order } from './fixtures';

describe('toFn', () => {
  it('compiles comparisons', () => {
    expect(toFn<Customer>(eq('city', 'Berlin'))(alfreds)).toBe(true);
    expect(toFn<Customer>(eq('city', 'Bonn'))(alfreds)).toBe(false);
  });

  it('compiles string operators', () => {
    const f = toFn<Customer>(or(starts('name', 'Al'), has('name', 'Horn')));
    expect(customers.filter(f).map((c) => c.id)).toEqual([1, 3]);
  });

  it('compares dates and numbers', () => {
    expect(orders.filter(toFn<Order>(ge('placed', new Date('2024-02-01')))).map((o) => o.id)).toEqual([11, 12]);
    expect(orders.filter(toFn<Order>(gt('total', 90))).map((o) => o.id)).toEqual([10, 11]);
  });

  it('handles in, not and any over nested arrays', () => {
    expect(customers.filter(toFn<Customer>(oneOf('id', [2, 3]))).length).toBe(2);
    expect(customers.filter(toFn<Customer>(not(eq('city', 'Berlin')))).length).toBe(2);
    const withOrders = customers.map((c) => ({ ...c, orders: orders.filter((o) => o.customerId === c.id) }));
    expect(withOrders.filter(toFn<Customer>(any('orders', gt('total', 200)))).map((c) => c.id)).toEqual([1]);
    expect(withOrders.filter(toFn<Customer>(and(eq('city', 'London'), any('orders', eq('total', 75))))).length).toBe(1);
  });
});

describe('run', () => {
  it('filters, orders, pages and projects', () => {
    const q = query<Order>('Order', where(gt('total', 50)), order('total', 'desc'), skip(1), take(1), pick('id'));
    expect(run(q, orders)).toEqual([{ id: 10 }]);
  });

  it('orders by several keys', () => {
    const q = query<Order>('Order', order('customerId'), order('total', 'desc'));
    expect(run(q, orders).map((o) => o.id)).toEqual([11, 10, 12]);
  });

  it('builds immutable queries', () => {
    const base = query<Order>('Order');
    const paged = take<Order>(5)(base);
    expect(base.take).toBeUndefined();
    expect(paged.take).toBe(5);
    expect(query<Order>('Order', where(eq('id', 1)), where(eq('total', 2))).where?.op).toBe('and');
  });

  it('composes with rxjs pipe', () => {
    const q = pipe(where<Order>(eq('customerId', 1)), order<Order>('total'))(query<Order>('Order'));
    expect(run(q, orders).map((o) => o.id)).toEqual([10, 11]);
  });
});
