/**
 * rxjs-breeze in the browser: the public Northwind OData v4 service queried
 * from a page, results merged into the store, edits tracked and watched live.
 * Served by Vite (`npm run web`), which imports the library source directly.
 */
import { firstValueFrom } from 'rxjs';
import {
  type Op,
  type Query,
  client,
  count,
  eq,
  expand,
  http,
  keyId,
  order,
  query,
  schema,
  store,
  take,
  toOData,
  where,
} from '../../src/index';

interface Customer {
  CustomerID: string;
  CompanyName: string;
  City: string;
  Country: string;
  Orders?: Order[];
}

interface Order {
  OrderID: number;
  CustomerID: string;
  OrderDate: Date;
  Freight: number;
  ShipCity: string;
  Customer?: Customer | null;
}

const BASE = 'https://services.odata.org/V4/Northwind/Northwind.svc';

const nw = schema({
  Customers: {
    key: 'CustomerID',
    props: { CustomerID: 'string', CompanyName: 'string', City: 'string', Country: 'string' },
    navs: { Orders: { to: 'Orders', fk: 'CustomerID', many: true } },
  },
  Orders: {
    key: 'OrderID',
    props: { OrderID: 'number', CustomerID: 'string', OrderDate: 'date', Freight: 'number', ShipCity: 'string' },
    navs: { Customer: { to: 'Customers', fk: 'CustomerID' } },
  },
});

const db = client(store(nw), http(BASE));

// --- small DOM helpers, no framework ---------------------------------------

type Child = Node | string | null | undefined;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Readonly<Record<string, string>> = {},
  ...children: readonly Child[]
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c != null) node.append(c);
  return node;
};

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

const show = (id: string, ...children: readonly Child[]): void =>
  byId(id).replaceChildren(...children.filter((c): c is Node | string => c != null));

const status = (text: string): void => {
  byId('status').textContent = text;
};

const row = (...cells: readonly Child[]): HTMLTableRowElement =>
  el('tr', {}, ...cells.map((c) => el('td', {}, c)));

const head = (...names: readonly string[]): HTMLTableSectionElement =>
  el('thead', {}, el('tr', {}, ...names.map((n) => el('th', {}, n))));

// --- 1. query the server ----------------------------------------------------

const customersQuery = (): Query<Customer> => {
  const country = byId<HTMLInputElement>('country').value.trim();
  const sort = byId<HTMLSelectElement>('sort').value;
  const dir = byId<HTMLSelectElement>('dir').value === 'desc' ? 'desc' : 'asc';
  const top = Number(byId<HTMLInputElement>('top').value) || 5;
  const ops: Op<Customer>[] = [];
  if (country) ops.push(where(eq('Country', country)));
  ops.push(order(sort, dir), take(top), count());
  return query<Customer>('Customers', ...ops);
};

const preview = (): void => {
  byId('url').textContent = `GET ${BASE}/${decodeURIComponent(toOData(customersQuery()))}`;
};

const customersTable = (rows: readonly Customer[]): HTMLTableElement =>
  el(
    'table',
    {},
    head('ID', 'Company', 'City (editable)', 'Country'),
    el(
      'tbody',
      {},
      ...rows.map((c) => {
        const city = el('input', { value: c.City });
        city.addEventListener('change', () => {
          db.store.patch<Customer>('Customers', c.CustomerID, { City: city.value });
        });
        const name = el('a', { href: '#' }, c.CompanyName);
        name.addEventListener('click', (ev) => {
          ev.preventDefault();
          void loadOrders(c);
        });
        return row(c.CustomerID, name, city, c.Country);
      }),
    ),
  );

let last: Query<Customer> | null = null;

const runCustomers = async (): Promise<void> => {
  const q = customersQuery();
  last = q;
  preview();
  status('loading from services.odata.org ...');
  try {
    const page = await firstValueFrom(db.page(q));
    status(
      `${page.count ?? '?'} customers match on the server; showing ${page.rows.length}. ` +
        'Click a company for its orders, or edit a city.',
    );
    show('customers', customersTable(page.rows));
  } catch (e) {
    status(`failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};

// --- 2. expand a navigation -------------------------------------------------

const loadOrders = async (c: Customer): Promise<void> => {
  const q = query<Order>(
    'Orders',
    where(eq('CustomerID', c.CustomerID)),
    order('OrderDate', 'desc'),
    expand('Customer'),
    take(5),
  );
  const url = `GET ${BASE}/${decodeURIComponent(toOData(q))}`;
  show('orders', el('h3', {}, `Latest orders of ${c.CompanyName}`), el('pre', {}, url), el('p', { class: 'muted' }, 'loading ...'));
  try {
    const orders = await firstValueFrom(db.fetch(q));
    show(
      'orders',
      el('h3', {}, `Latest orders of ${c.CompanyName}`),
      el('pre', {}, url),
      el(
        'table',
        {},
        head('Order', 'Date', 'Ship to', 'Freight', 'Customer (expanded)'),
        el(
          'tbody',
          {},
          ...orders.map((o) =>
            row(
              String(o.OrderID),
              o.OrderDate.toISOString().slice(0, 10),
              o.ShipCity,
              o.Freight.toFixed(2),
              o.Customer?.CompanyName ?? '',
            ),
          ),
        ),
      ),
      el(
        'p',
        { class: 'muted' },
        `The expanded customers were normalized into the cache. The same query object, run locally with store.run, returns ${db.store.run(q).length} orders.`,
      ),
    );
  } catch (e) {
    show('orders', el('p', {}, `failed: ${e instanceof Error ? e.message : String(e)}`));
  }
};

// --- 3. watch the cache -----------------------------------------------------

db.store.watch(query<Customer>('Customers', order('CompanyName'))).subscribe((customers) => {
  show(
    'cache',
    ...customers.map((c) => el('li', {}, `${c.CustomerID}  ${c.CompanyName}: ${c.City}, ${c.Country}`)),
  );
});

// --- 4. change tracking -----------------------------------------------------

db.store.changes$.subscribe((rows) => {
  show(
    'changes',
    ...rows.map((r) =>
      el('li', {}, `${r.type} ${keyId(r.key)}: ${r.state}${r.orig ? `, was ${JSON.stringify(r.orig)}` : ''}`),
    ),
  );
  byId<HTMLButtonElement>('revert').disabled = rows.length === 0;
});

byId('revert').addEventListener('click', () => {
  db.store.revert();
  if (last) show('customers', customersTable(db.store.run(last)));
});

// --- wiring -----------------------------------------------------------------

byId('form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  void runCustomers();
});
for (const id of ['country', 'sort', 'dir', 'top']) byId(id).addEventListener('input', preview);

preview();
void runCustomers();
