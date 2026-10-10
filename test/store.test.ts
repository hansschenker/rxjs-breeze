import { describe, expect, it } from 'vitest';
import { eq } from '../src/pred';
import { expand, order, query, where } from '../src/query';
import { store } from '../src/store';
import { alfreds, customers, nw, orders, type Customer, type Order } from './fixtures';

describe('store', () => {
  it('tracks patches with original values and reverts them', () => {
    const s = store(nw);
    s.attach('Customer', alfreds);
    const updated = s.patch<Customer>('Customer', 1, { city: 'Bonn' });
    expect(updated.city).toBe('Bonn');
    const [row] = s.changes();
    expect(row?.state).toBe('changed');
    expect(row?.orig).toEqual({ city: 'Berlin' });
    s.patch<Customer>('Customer', 1, { city: 'Köln' });
    expect(s.changes()[0]?.orig).toEqual({ city: 'Berlin' });
    s.revert('Customer', 1);
    expect(s.changes()).toEqual([]);
    expect(s.get<Customer>('Customer', 1)?.city).toBe('Berlin');
  });

  it('assigns temporary keys to added entities and forgets them on remove', () => {
    const s = store(nw);
    const c = s.add<{ id?: number; name: string; city: string }>('Customer', { name: 'New', city: 'Oslo' });
    expect(c.id).toBeLessThan(0);
    expect(s.changes()[0]?.state).toBe('added');
    s.remove('Customer', c.id ?? 0);
    expect(s.changes()).toEqual([]);
  });

  it('marks clean entities removed until saved', () => {
    const s = store(nw);
    s.attach('Customer', alfreds);
    s.remove('Customer', 1);
    expect(s.get('Customer', 1)).toBeUndefined();
    expect(s.run(query<Customer>('Customer'))).toEqual([]);
    expect(s.changes()[0]?.state).toBe('removed');
    s.revert();
    expect(s.get<Customer>('Customer', 1)).toEqual(alfreds);
  });

  it('merges with keep, skip and overwrite', () => {
    const s = store(nw);
    s.attach('Customer', alfreds);
    s.patch<Customer>('Customer', 1, { city: 'Bonn' });
    const fresh = { ...alfreds, city: 'Hamburg' };
    expect(s.merge('Customer', [fresh], 'keep')[0]?.city).toBe('Bonn');
    expect(s.merge('Customer', [fresh], 'skip')).toEqual([]);
    expect(s.merge('Customer', [fresh], 'overwrite')[0]?.city).toBe('Hamburg');
    expect(s.changes()).toEqual([]);
  });

  it('keeps object identity when merged data is unchanged', () => {
    const s = store(nw);
    const [first] = s.merge('Customer', [{ ...alfreds }]);
    const [second] = s.merge('Customer', [{ ...alfreds }]);
    expect(second).toBe(first);
  });

  it('normalizes nested navigations on merge and fills them on read', () => {
    const s = store(nw);
    s.merge('Customer', [{ ...alfreds, orders: orders.filter((o) => o.customerId === 1) }]);
    expect(s.get<Customer>('Customer', 1)).toEqual(alfreds);
    expect(s.get<Order>('Order', 10)?.total).toBe(100);

    const [c] = s.run(query<Customer>('Customer', where(eq('id', 1)), expand('orders')));
    expect(c?.orders?.map((o) => o.id)).toEqual([10, 11]);

    const [o] = s.run(query<Order>('Order', where(eq('customer.city', 'Berlin')), order('total', 'desc')));
    expect(o?.id).toBe(11);
    expect(o !== undefined && 'customer' in o).toBe(false);

    const [deep] = s.run(query<Order>('Order', where(eq('id', 10)), expand('customer.orders')));
    expect(deep?.customer?.orders?.length).toBe(2);
  });

  it('watches a query and emits only when its result changes', () => {
    const s = store(nw);
    s.merge('Customer', customers);
    const seen: number[][] = [];
    const sub = s
      .watch(query<Customer>('Customer', where(eq('city', 'Berlin'))))
      .subscribe((cs) => seen.push(cs.map((c) => c.id)));
    s.patch<Customer>('Customer', 2, { city: 'Berlin' });
    s.patch<Customer>('Customer', 3, { name: 'unrelated' });
    s.remove('Customer', 1);
    sub.unsubscribe();
    expect(seen).toEqual([[1], [1, 2], [2]]);
  });

  it('streams pending changes', () => {
    const s = store(nw);
    const counts: number[] = [];
    const sub = s.changes$.subscribe((rows) => counts.push(rows.length));
    s.attach('Customer', alfreds);
    s.patch<Customer>('Customer', 1, { city: 'Bonn' });
    s.revert();
    sub.unsubscribe();
    expect(counts).toEqual([0, 1, 0]);
  });

  it('snapshots and restores with dates and pending changes intact', () => {
    const s = store(nw);
    s.merge('Order', orders);
    s.patch<Order>('Order', 10, { total: 1 });
    const s2 = store(nw);
    s2.restore(s.snapshot());
    expect(s2.changes().length).toBe(1);
    expect(s2.get<Order>('Order', 11)?.placed).toBeInstanceOf(Date);
    expect(s2.get<Order>('Order', 10)?.total).toBe(1);
  });
});
