// The reference JSON server and the http client provider, end to end, in one
// process: no OData anywhere, just rxjs-breeze's own JSON wire format.
// Run:  npm run build && node examples/json.mjs
import { firstValueFrom } from 'rxjs';
import { client, count, eq, expand, http, memory, order, query, schema, store, take, toJsonUrl, where } from '../dist/index.js';
import { serve } from '../dist/server.js';

const nw = schema({
  Customer: {
    key: 'id',
    props: { id: 'number', name: 'string', city: 'string', country: 'string' },
    navs: { orders: { to: 'Order', fk: 'customerId', many: true } },
  },
  Order: {
    key: 'id',
    props: { id: 'number', customerId: 'number', total: 'number', placed: 'date' },
    navs: { customer: { to: 'Customer', fk: 'customerId' } },
  },
});

const seed = {
  Customer: [
    { id: 1, name: 'Alfreds Futterkiste', city: 'Berlin', country: 'Germany' },
    { id: 2, name: 'Blauer See Delikatessen', city: 'Mannheim', country: 'Germany' },
    { id: 3, name: 'Around the Horn', city: 'London', country: 'UK' },
  ],
  Order: [
    { id: 10, customerId: 1, total: 100, placed: new Date('2024-01-05') },
    { id: 11, customerId: 1, total: 250, placed: new Date('2024-02-10') },
    { id: 12, customerId: 3, total: 75, placed: new Date('2024-03-01') },
  ],
};

// 1. Serve any provider; memory is the reference backend.
const server = await serve(memory(nw, seed));
console.log('reference JSON server at', server.url);

// 2. The client speaks the same format through http + toJsonUrl.
const connect = () => client(store(nw), http(server.url, { url: toJsonUrl }));
const db = connect();

const germans = query('Customer', where(eq('country', 'Germany')), order('name'), take(5), count());
console.log('GET', `${server.url}/${toJsonUrl(germans)}`);
const page = await firstValueFrom(db.page(germans));
console.log(`${page.count} German customers:`, page.rows.map((c) => c.name).join(', '));

const big = query('Order', where(eq('customerId', 1)), order('placed', 'desc'), expand('customer'));
const orders = await firstValueFrom(db.fetch(big));
console.log('orders of', orders[0]?.customer?.name, '->', orders.map((o) => `${o.id} on ${o.placed.toISOString().slice(0, 10)}`).join(', '));

// 3. Edit, add, remove, save: POST /save with the change set, keys fixed up from the reply.
db.store.patch('Customer', 2, { city: 'Heidelberg' });
db.store.add('Order', { customerId: 2, total: 42, placed: new Date() });
db.store.remove('Order', 11);
const saved = await firstValueFrom(db.save());
console.log('saved:', saved.rows.length, 'rows,', saved.removed.length, 'removed, new order id', saved.rows.find((r) => r.was)?.data.id);

// 4. A fresh client sees the server's state.
const fresh = await firstValueFrom(connect().fetch(query('Order', order('id'))));
console.log('server now has orders', fresh.map((o) => `${o.id} (customer ${o.customerId})`).join(', '));

await server.close();
