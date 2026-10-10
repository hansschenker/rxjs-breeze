import { schema } from '../src/schema';

export const nw = schema({
  Customer: {
    key: 'id',
    props: { id: 'number', name: 'string', city: 'string' },
    navs: { orders: { to: 'Order', fk: 'customerId', many: true } },
  },
  Order: {
    key: 'id',
    props: { id: 'number', customerId: 'number', total: 'number', placed: 'date' },
    navs: {
      customer: { to: 'Customer', fk: 'customerId' },
      lines: { to: 'Line', fk: 'orderId', many: true },
    },
  },
  Line: {
    key: ['orderId', 'productId'],
    props: { orderId: 'number', productId: 'number', qty: 'number' },
    navs: { order: { to: 'Order', fk: 'orderId' } },
  },
});

export interface Customer {
  id: number;
  name: string;
  city: string;
  orders?: Order[];
}

export interface Order {
  id: number;
  customerId: number;
  total: number;
  placed: Date;
  customer?: Customer | null;
  lines?: Line[];
}

export interface Line {
  orderId: number;
  productId: number;
  qty: number;
}

export const alfreds: Customer = { id: 1, name: 'Alfreds Futterkiste', city: 'Berlin' };
export const ana: Customer = { id: 2, name: 'Ana Trujillo', city: 'México D.F.' };
export const horn: Customer = { id: 3, name: 'Around the Horn', city: 'London' };
export const customers: Customer[] = [alfreds, ana, horn];

export const o10: Order = { id: 10, customerId: 1, total: 100, placed: new Date('2024-01-05T00:00:00.000Z') };
export const o11: Order = { id: 11, customerId: 1, total: 250, placed: new Date('2024-02-10T00:00:00.000Z') };
export const o12: Order = { id: 12, customerId: 3, total: 75, placed: new Date('2024-03-01T00:00:00.000Z') };
export const orders: Order[] = [o10, o11, o12];

export const lines: Line[] = [
  { orderId: 10, productId: 1, qty: 2 },
  { orderId: 10, productId: 2, qty: 1 },
  { orderId: 12, productId: 1, qty: 5 },
];
