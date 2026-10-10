// Create, update, read back and delete against the public TripPin service,
// a writable OData v4 sandbox (each session key gets its own scratch data).
// Run:  npm run build && node examples/trippin.mjs
import { firstValueFrom } from 'rxjs';
import { client, eq, odata, query, schema, store, where } from '../dist/index.js';

const trip = schema({
  People: {
    key: 'UserName',
    props: { UserName: 'string', FirstName: 'string', LastName: 'string', AddressInfo: 'Location[]' },
  },
  Location: { props: { Address: 'string', City: 'City' } },
  City: { props: { Name: 'string', CountryRegion: 'string', Region: 'string' } },
});

const session = Date.now().toString(36);
const base = `https://services.odata.org/TripPinRESTierService/(S(rb${session}))`;
const db = client(store(trip), odata(trip, base));
const user = `rb${session}`;

// POST People
db.store.add('People', {
  UserName: user,
  FirstName: 'Rx',
  LastName: 'Breeze',
  Emails: [`${user}@example.com`],
  AddressInfo: [{ Address: '1 Observable Way', City: { Name: 'Zürich', CountryRegion: 'Switzerland', Region: 'ZH' } }],
});
let saved = await firstValueFrom(db.save());
console.log('created ', saved.rows[0]?.data.UserName, saved.rows[0]?.data.FirstName);

// PATCH People('user') with only the changed property
db.store.patch('People', user, { FirstName: 'Reactive' });
saved = await firstValueFrom(db.save());
console.log('patched ', saved.rows[0]?.data.FirstName);

// GET People?$filter=UserName eq 'user'   (merged into the cache, complex values intact)
const [back] = await firstValueFrom(db.fetch(query('People', where(eq('UserName', user))), { merge: 'overwrite' }));
console.log('fetched ', back?.FirstName, back?.LastName, 'in', back?.AddressInfo?.[0]?.City?.Name);

// DELETE People('user')
db.store.remove('People', user);
saved = await firstValueFrom(db.save());
console.log('deleted ', saved.removed?.[0]?.key, '| pending changes:', db.store.changes().length);
