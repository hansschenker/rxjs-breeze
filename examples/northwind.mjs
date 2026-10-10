// Query the public Northwind OData v4 service with rxjs-breeze.
// Run:  npm run build && node examples/northwind.mjs
//
// Schema type names double as OData entity-set names, so no URL mapping is
// needed. To map names instead, pass `url: (q) => toOData({ ...q, type: sets[q.type] })` to `http`.
import { firstValueFrom } from 'rxjs';
import { client, count, eq, expand, http, order, query, schema, store, take, where } from '../dist/index.js';

const nw = schema({
  Customers: {
    key: 'CustomerID',
    props: { CustomerID: 'string', CompanyName: 'string', City: 'string', Country: 'string' },
    navs: { Orders: { to: 'Orders', fk: 'CustomerID', many: true } },
  },
  Orders: {
    key: 'OrderID',
    props: { OrderID: 'number', CustomerID: 'string', OrderDate: 'date', Freight: 'number' },
    navs: { Customer: { to: 'Customers', fk: 'CustomerID' } },
  },
});

const db = client(store(nw), http('https://services.odata.org/V4/Northwind/Northwind.svc'));

// 1. A paged, counted query. On the wire:
//    Customers?$filter=Country eq 'Germany'&$orderby=CompanyName&$top=3&$count=true
const germans = query('Customers', where(eq('Country', 'Germany')), order('CompanyName'), take(3), count());
const page = await firstValueFrom(db.page(germans));
console.log(`${page.count} German customers, first ${page.rows.length}:`);
for (const c of page.rows) console.log(`  ${c.CustomerID}  ${c.CompanyName}  (${c.City})`);

// 2. Orders with their customer expanded. Dates arrive as Date objects.
const recent = query('Orders', where(eq('CustomerID', 'ALFKI')), order('OrderDate', 'desc'), expand('Customer'), take(2));
const orders = await firstValueFrom(db.fetch(recent));
for (const o of orders) {
  console.log(`  order ${o.OrderID} on ${o.OrderDate.toISOString().slice(0, 10)}, freight ${o.Freight}, for ${o.Customer?.CompanyName}`);
}

// 3. The cache now holds the normalized entities, and the same query runs locally.
console.log('cached customers:', db.store.run(query('Customers')).map((c) => c.CustomerID).join(', '));
console.log('same query, local:', db.store.run(recent).map((o) => o.OrderID));
