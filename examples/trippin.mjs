// Create, update, read back and delete against the public TripPin service,
// a writable OData v4 sandbox (each session key gets its own scratch data).
// Every save goes out as one $batch changeset, so it is applied atomically.
// Run:  npm run build && node examples/trippin.mjs
import { firstValueFrom } from 'rxjs';
import { client, eq, odata, oneOf, query, schema, store, where } from '../dist/index.js';

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
const db = client(store(trip), odata(trip, base, { batch: 'multipart' }));
const [alice, bob] = [`rba${session}`, `rbb${session}`];

// One $batch with two POSTs
db.store.add('People', {
  UserName: alice,
  FirstName: 'Rx',
  LastName: 'Breeze',
  Emails: [`${alice}@example.com`],
  AddressInfo: [{ Address: '1 Observable Way', City: { Name: 'Zürich', CountryRegion: 'Switzerland', Region: 'ZH' } }],
});
db.store.add('People', { UserName: bob, FirstName: 'Bob', LastName: 'Subject', Emails: [] });
let saved = await firstValueFrom(db.save());
console.log('created ', saved.rows.map((r) => `${r.data.UserName} (${r.data.FirstName})`).join(', '));

// One $batch with a PATCH (only the changed property) and a DELETE
db.store.patch('People', alice, { FirstName: 'Reactive' });
db.store.remove('People', bob);
saved = await firstValueFrom(db.save());
console.log('patched ', saved.rows[0]?.data.FirstName, '| deleted', saved.removed?.[0]?.key);

// GET People?$filter=(UserName eq 'a' or UserName eq 'b')   (merged into the cache, complex values intact)
const back = await firstValueFrom(db.fetch(query('People', where(oneOf('UserName', [alice, bob]))), { merge: 'overwrite' }));
console.log('fetched ', back.map((p) => `${p.FirstName} ${p.LastName} in ${p.AddressInfo?.[0]?.City?.Name ?? '?'}`).join(', '));

// Clean up
db.store.remove('People', alice);
saved = await firstValueFrom(db.save());
console.log('deleted ', saved.removed?.[0]?.key, '| pending changes:', db.store.changes().length);
