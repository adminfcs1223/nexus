// MVP acceptance (2026-11-24): the nine behaviours both warehouse applications depend on, over real HTTP, on a throwaway
// local database loaded with exactly what Nexus staging runs (001-005 + 007). The fixture mirrors the frozen staging floor
// (one ShipBay pallet at P-01, one Souled pallet at P-02, P-03 empty) with its own made-up pallet ids. No hosted system is
// touched. `node --test neutral/test/mvp-acceptance.test.mjs`   (NEXUS_EXAMPLES=<file> also writes the request/response
// pairs the contract document quotes.)
import test from 'node:test'; import assert from 'node:assert/strict'; import pg from 'pg'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { serve } from '../service/server.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)); const base = 'postgres://postgres@127.0.0.1:54318'; const DBN = 'nexusmvp'; const FLOOR = 'HILLSBOROUGH-TEST';
const boot = new pg.Client(`${base}/postgres`); await boot.connect(); await boot.query(`drop database if exists ${DBN}`); await boot.query(`create database ${DBN}`); await boot.end();
const db = new pg.Pool({ connectionString: `${base}/${DBN}` });
for (const f of ['001_core.sql', '002_floor_map.sql', '003_calendar.sql', '004_baseline.sql', '005_key_handoff.sql', '007_destinations_only.sql']) await db.query(fs.readFileSync(path.join(here, '..', f), 'utf8'));
const one = async (sql, p) => Object.values((await db.query(sql, p)).rows[0])[0]; const rows = async (sql, p) => (await db.query(sql, p)).rows;
const co = (code, name) => one(`insert into nexus.companies (code, name) values ($1, $2) returning id`, [code, name]);
const SOULED = await co('SOULED', 'Souled Worldwide'), SHIPBAY = await co('SHIPBAY', 'ShipBay3PL');
const key = (c, sys, wh, scopes) => one(`select nexus.integration_create('test', $1, $2, $3, $4)`, [c, sys, wh, scopes]);
const keys = { souled: await key(SOULED, 'souled-backend', FLOOR, ['read', 'move']), shipbay: await key(SHIPBAY, 'shipbay-bridge', FLOOR, ['read', 'move']), reader: await key(SOULED, 'souled-screen', FLOOR, ['read']),
  retired: await key(SHIPBAY, 'shipbay-old', FLOOR, ['read', 'move']), realFloor: await key(SOULED, 'souled-backend', 'HILLSBOROUGH', ['read', 'move']) };
await db.query(`update nexus.integrations set active = false where source_system = 'shipbay-old'`);
let svc = await serve(`${base}/${DBN}`); let n = 0; const examples = [];
const sys = (k, who) => async (method, p, body, idem, note) => {
  const headers = { authorization: `Bearer ${k}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(method === 'POST' ? { 'idempotency-key': idem || `mvp-${++n}` } : {}) };
  const r = await fetch(svc.url + p, { method, headers, body: body ? JSON.stringify(body) : undefined }); const j = await r.json();
  if (note) examples.push({ note, caller: who, request: `${method} ${p}`, idempotency_key: headers['idempotency-key'], body, status: r.status, response: j });
  return { ...j, status: r.status };
};
const souled = sys(keys.souled, 'SOULED'), shipbay = sys(keys.shipbay, 'SHIPBAY'), reader = sys(keys.reader, 'SOULED (read-only key)'), retired = sys(keys.retired, 'retired key'), realFloor = sys(keys.realFloor, 'SOULED (real-floor key)');
test.after(async () => { if (process.env.NEXUS_EXAMPLES) fs.writeFileSync(process.env.NEXUS_EXAMPLES, JSON.stringify(examples, null, 2)); await svc.close(); await db.end(); });
const at = async (s, code) => (await s('GET', '/v1/occupancy')).locations.find((l) => l.code === code);
const moves = () => one(`select count(*)::int from nexus.moves`);
// the floor is consistent: nobody over capacity, nothing at a non-destination, one place per pallet, released pallets stand nowhere, and the two companies see the same counts
const consistent = async () => {
  assert.equal(await one(`select count(*)::int from nexus.locations l where l.capacity is not null and (select count(*) from nexus.occupancy o where o.location_id = l.id) > l.capacity`), 0, 'over capacity');
  assert.equal(await one(`select count(*)::int from nexus.occupancy o join nexus.locations l on l.id = o.location_id where l.kind not in ('pallet', 'staging') or l.map_x is null`), 0, 'non-destination occupied');
  assert.equal(await one(`select count(*)::int from (select pallet_id from nexus.occupancy group by 1 having count(*) > 1) x`), 0, 'a pallet in two places');
  assert.equal(await one(`select count(*)::int from nexus.pallets p join nexus.occupancy o on o.pallet_id = p.id where p.status = 'released'`), 0, 'released pallet still placed');
  assert.equal(await one(`select count(*)::int from nexus.occupancy o join nexus.pallets p on p.id = o.pallet_id join nexus.locations l on l.id = o.location_id where l.warehouse <> p.warehouse`), 0, 'pallet on another floor');
  const a = await souled('GET', '/v1/occupancy'), b = await shipbay('GET', '/v1/occupancy'); const shape = (o) => o.locations.map((l) => [l.code, l.status, l.capacity, l.used, l.free, JSON.stringify(l.occupants)]);
  assert.deepEqual(shape(a), shape(b), 'both companies see the same floor'); assert.equal(a.locations.reduce((t, l) => t + l.used, 0), await one(`select count(*)::int from nexus.occupancy`));
};

test('fixture: the frozen staging floor, mirrored (ShipBay at P-01, Souled at P-02, P-03 empty); Nexus holds no quantities or products', async () => {
  assert.equal((await shipbay('POST', '/v1/pallets/assign', { pallet: 'FIX-B-0001', to: 'P-01' })).ok, true); assert.equal((await souled('POST', '/v1/pallets/assign', { pallet: 'FIX-S-0001', to: 'P-02' })).ok, true);
  const m = await souled('GET', '/v1/map', null, null, 'The map'); assert.deepEqual([m.map_version, m.checksum, m.positions.length, m.moves_enabled], [4, 'be3cc8f3e9134cb4dfe7d3ac41773bc5d231ed56b4a42c05f5939467d67c8c4f', 69, true]);
  assert.deepEqual((await rows(`select column_name from information_schema.columns where table_schema = 'nexus' and column_name ~* 'qty|quantity|units|sku|product'`)), []); await consistent();
});

test('1-3, 8: locations are registered and shown; each is open, occupied or unavailable; a pallet belongs to one company; both companies get the same availability', async () => {
  const o = await shipbay('GET', '/v1/occupancy'); assert.equal(o.locations.length, 69); assert.deepEqual([o.locations.filter((l) => l.kind === 'pallet').length, o.locations.filter((l) => l.kind === 'staging').length, o.locations.filter((l) => l.kind === 'dock').length], [66, 2, 1]);
  const p1 = await at(shipbay, 'P-01'), p2 = await at(shipbay, 'P-02'), p3 = await at(shipbay, 'P-03');
  assert.deepEqual([p1.used, p1.free, p1.occupants, p1.your_pallets], [1, 0, [{ company: 'SHIPBAY', pallets: 1 }], ['FIX-B-0001']]);
  assert.deepEqual([p2.used, p2.free, p2.occupants, p2.your_pallets], [1, 0, [{ company: 'SOULED', pallets: 1 }], []]); assert.deepEqual([p3.status, p3.capacity, p3.used, p3.free, p3.occupants], ['open', 1, 0, 1, []]);
  examples.push({ note: 'Occupancy entries as SHIPBAY sees them: its own pallet, the other company\'s pallet, an empty position', caller: 'SHIPBAY', request: 'GET /v1/occupancy', status: 200, response: { ok: true, warehouse: o.warehouse, occupancy_state: o.occupancy_state, moves_enabled: o.moves_enabled, as_of: o.as_of, locations: [p1, p2, p3, '… 66 more'] } });
  // unavailable and blocked: set by Nexus administration, visible to both, refused as destinations, and reversible
  await one(`select nexus.location_set('test', $1, 'P-10', 'unavailable', 'rack removed', null)`, [FLOOR]); await one(`select nexus.location_set('test', $1, 'P-11', 'blocked', 'spill', null)`, [FLOOR]);
  assert.deepEqual([(await at(souled, 'P-10')).status, (await at(shipbay, 'P-11')).status], ['unavailable', 'blocked']);
  const un = await souled('POST', '/v1/pallets/assign', { pallet: 'MVP-S-10', to: 'P-10' }, null, 'Destination not in use'); assert.deepEqual([un.status, un.error], [409, 'location_unavailable']);
  const bl = await shipbay('POST', '/v1/pallets/assign', { pallet: 'MVP-B-11', to: 'P-11' }, null, 'Destination blocked'); assert.deepEqual([bl.status, bl.error, bl.message], [409, 'location_blocked', 'spill']);
  await one(`select nexus.location_set('test', $1, 'P-10', 'open', null, null)`, [FLOOR]); await one(`select nexus.location_set('test', $1, 'P-11', 'open', null, null)`, [FLOOR]);
  assert.equal((await souled('GET', '/v1/map')).checksum.length, 64); await consistent();
});

test('4-5: an empty valid location accepts one pallet; a second, competing assignment is refused, also when both arrive at once', async () => {
  const ok = await souled('POST', '/v1/pallets/assign', { pallet: 'MVP-S-1', to: 'P-03' }, 'souled-assign-0001', 'Assign to an empty position'); assert.deepEqual([ok.status, ok.ok, ok.location, ok.free, ok.from], [200, true, 'P-03', 0, null]);
  const second = await shipbay('POST', '/v1/pallets/assign', { pallet: 'MVP-B-1', to: 'P-03' }, 'shipbay-assign-0001', 'Assign to an occupied position'); assert.deepEqual([second.status, second.error, second.capacity, second.used], [409, 'location_full', 1, 1]);
  assert.ok(!JSON.stringify(second).includes('MVP-S-1'), 'the refusal does not name the other company\'s pallet');
  assert.deepEqual((await at(shipbay, 'P-03')).occupants, [{ company: 'SOULED', pallets: 1 }]); assert.equal(await one(`select count(*)::int from nexus.occupancy o join nexus.pallets p on p.id = o.pallet_id where p.external_id = 'MVP-B-1'`), 0, 'the refused pallet stands nowhere');
  const own = await souled('POST', '/v1/pallets/assign', { pallet: 'MVP-S-2', to: 'P-03' }); assert.equal(own.error, 'location_full', 'also for the same company');
  const race = await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? souled : shipbay)('POST', '/v1/pallets/assign', { pallet: `MVP-R-${i}`, to: 'P-04' })));
  assert.deepEqual([race.filter((r) => r.ok).length, race.filter((r) => r.error === 'location_full').length], [1, 23]); assert.equal((await at(souled, 'P-04')).used, 1); await consistent();
});

test('4: an invalid or undrawn destination is refused, and RCV-DOCK cannot hold a pallet', async () => {
  const before = await one(`select count(*)::int from nexus.occupancy`);
  const none = await souled('POST', '/v1/pallets/assign', { pallet: 'MVP-S-3', to: 'P-67' }, null, 'Destination does not exist'); assert.deepEqual([none.status, none.error], [404, 'location_not_found']);
  for (const to of ['P-00', 'P-1', 'P1', 'Z-01', '', null, 'P-01; drop table']) { const r = await souled('POST', '/v1/pallets/assign', { pallet: 'MVP-S-3', to }); assert.deepEqual([r.status, r.error], [404, 'location_not_found'], String(to)); }
  const dock = await shipbay('POST', '/v1/pallets/assign', { pallet: 'MVP-B-3', to: 'RCV-DOCK' }, null, 'Destination is the dock'); assert.deepEqual([dock.status, dock.error, dock.location], [409, 'location_not_a_destination', 'RCV-DOCK']);
  assert.equal((await souled('POST', '/v1/pallets/move', { pallet: 'MVP-S-1', to: 'rcv-dock', from: 'P-03' })).error, 'location_not_a_destination'); assert.equal((await at(souled, 'P-03')).your_pallets[0], 'MVP-S-1', 'and the pallet stays put');
  await assert.rejects(db.query(`insert into nexus.occupancy (pallet_id, location_id, placed_by) select p.id, l.id, 'x' from nexus.pallets p, nexus.locations l where p.external_id = 'MVP-B-3' and l.warehouse = $1 and l.code = 'RCV-DOCK'`, [FLOOR]), /not a pallet storage position/);
  for (const [body, why] of [[{ to: 'P-05' }, 'no pallet'], [{ pallet: '', to: 'P-05' }, 'empty pallet'], [{ pallet: 'x'.repeat(65), to: 'P-05' }, 'long pallet id']]) assert.equal((await souled('POST', '/v1/pallets/assign', body)).status, 400, why);
  assert.deepEqual([(await at(souled, 'RCV-DOCK')).used, await one(`select count(*)::int from nexus.occupancy`)], [0, before]); await consistent();
});

test('6: a valid move frees the source and occupies the destination, in one step', async () => {
  const mv = await souled('POST', '/v1/pallets/move', { pallet: 'MVP-S-1', to: 'P-05', from: 'P-03' }, 'souled-move-0001', 'Move a pallet'); assert.deepEqual([mv.status, mv.ok, mv.from, mv.location, mv.free], [200, true, 'P-03', 'P-05', 0]);
  const [src, dst] = [await at(shipbay, 'P-03'), await at(shipbay, 'P-05')]; assert.deepEqual([src.used, src.free, src.occupants, dst.used, dst.free, dst.occupants], [0, 1, [], 1, 0, [{ company: 'SOULED', pallets: 1 }]]);
  assert.equal((await shipbay('POST', '/v1/pallets/assign', { pallet: 'MVP-B-1', to: 'P-03' }, 'shipbay-assign-0002')).ok, true, 'the freed position is available to the other company at once');
  assert.equal((await souled('POST', '/v1/pallets/move', { pallet: 'MVP-S-1', to: 'P-03', from: 'P-05' })).error, 'location_full', 'and a move into a taken position is refused, pallet stays'); assert.equal((await at(souled, 'P-05')).your_pallets[0], 'MVP-S-1');
  const stg = await souled('POST', '/v1/pallets/move', { pallet: 'MVP-S-1', to: 'STG-01', from: 'P-05' }); assert.deepEqual([stg.ok, stg.free], [true, null]);
  const rel = await souled('POST', '/v1/pallets/release', { pallet: 'MVP-S-1', from: 'STG-01' }, 'souled-release-0001', 'Release a pallet (it leaves the floor)'); assert.deepEqual([rel.status, rel.released_from], [200, 'STG-01']);
  assert.equal((await at(souled, 'STG-01')).used, 0); assert.equal((await souled('POST', '/v1/pallets/assign', { pallet: 'MVP-S-1', to: 'P-05' })).ok, true, 'a released pallet can come back with a new assignment'); await consistent();
});

test('9: a duplicate request makes one record and one movement; a key cannot be reused for something else', async () => {
  const before = await moves(); const body = { pallet: 'MVP-S-1', to: 'P-06', from: 'P-05' };
  const first = await souled('POST', '/v1/pallets/move', body, 'souled-move-0002'); const again = await souled('POST', '/v1/pallets/move', body, 'souled-move-0002', 'The same request sent again with the same key');
  assert.deepEqual([first.ok, first.replayed, again.status, again.replayed, again.seq, again.location], [true, undefined, 200, true, first.seq, 'P-06']); assert.equal(await moves(), before + 1);
  const burst = await Promise.all(Array.from({ length: 12 }, () => souled('POST', '/v1/pallets/move', { pallet: 'MVP-S-1', to: 'P-07', from: 'P-06' }, 'souled-move-0003')));
  assert.deepEqual([burst.filter((r) => r.ok && !r.replayed).length, burst.filter((r) => r.replayed).length, new Set(burst.map((r) => r.seq)).size], [1, 11, 1], 'twelve at once: one movement, eleven replays'); assert.equal(await moves(), before + 2);
  const reuse = await souled('POST', '/v1/pallets/move', { pallet: 'MVP-S-1', to: 'P-08', from: 'P-07' }, 'souled-move-0003', 'The same key for a different request'); assert.deepEqual([reuse.status, reuse.error], [409, 'idempotency_key_reused']);
  assert.equal((await souled('POST', '/v1/pallets/release', { pallet: 'MVP-S-1' }, 'souled-move-0003')).error, 'idempotency_key_reused'); assert.equal((await at(souled, 'P-07')).your_pallets[0], 'MVP-S-1');
  // keys belong to one credential: the other company using the same text is a separate request
  assert.equal((await shipbay('POST', '/v1/pallets/assign', { pallet: 'MVP-B-9', to: 'P-09' }, 'souled-move-0003')).ok, true);
  const none = await souled('POST', '/v1/pallets/move', { pallet: 'MVP-S-1', to: 'P-08' }, null); assert.equal((await fetch(svc.url + '/v1/pallets/move', { method: 'POST', headers: { authorization: `Bearer ${keys.souled}` }, body: '{"pallet":"MVP-S-1","to":"P-08"}' })).status, 400, 'no key, no movement'); assert.equal(none.ok, true);
  await souled('POST', '/v1/pallets/move', { pallet: 'MVP-S-1', to: 'P-07', from: 'P-08' }); await consistent();
});

test('9: stale requests are refused and change nothing', async () => {
  const before = JSON.stringify((await shipbay('GET', '/v1/occupancy')).locations.map((l) => [l.code, l.used]));
  const stale = await souled('POST', '/v1/pallets/move', { pallet: 'MVP-S-1', to: 'P-12', from: 'P-05' }, 'souled-move-0004', 'A move from where the pallet no longer is'); assert.deepEqual([stale.status, stale.error, stale.location], [409, 'pallet_elsewhere', 'P-07']);
  assert.equal((await souled('POST', '/v1/pallets/release', { pallet: 'MVP-S-1', from: 'P-05' })).error, 'pallet_elsewhere');
  const twice = await souled('POST', '/v1/pallets/assign', { pallet: 'MVP-S-1', to: 'P-12' }, null, 'Assigning a pallet that is already on the floor'); assert.deepEqual([twice.status, twice.error, twice.location], [409, 'pallet_elsewhere', 'P-07']);
  const same = await souled('POST', '/v1/pallets/move', { pallet: 'MVP-S-1', to: 'P-07', from: 'P-07' }); assert.deepEqual([same.status, same.error], [409, 'already_there']);
  await souled('POST', '/v1/pallets/assign', { pallet: 'MVP-S-GONE', to: 'P-13' }); await souled('POST', '/v1/pallets/release', { pallet: 'MVP-S-GONE' });
  const gone = await souled('POST', '/v1/pallets/move', { pallet: 'MVP-S-GONE', to: 'P-13' }, null, 'Moving a pallet that is not on the floor'); assert.deepEqual([gone.status, gone.error], [409, 'pallet_not_placed']);
  const never = await souled('POST', '/v1/pallets/move', { pallet: 'MVP-S-NEVER', to: 'P-13' }, null, 'Moving a pallet Nexus has never seen'); assert.deepEqual([never.status, never.error], [404, 'pallet_not_found']);
  // an old refusal stays a refusal under its key even after the floor has changed; a new attempt needs a new key
  await souled('POST', '/v1/pallets/move', { pallet: 'MVP-S-1', to: 'P-05', from: 'P-07' }); const old = await souled('POST', '/v1/pallets/move', { pallet: 'MVP-S-1', to: 'P-12', from: 'P-05' }, 'souled-move-0004');
  assert.deepEqual([old.error, old.replayed], ['pallet_elsewhere', true]); assert.equal((await souled('POST', '/v1/pallets/move', { pallet: 'MVP-S-1', to: 'P-07', from: 'P-05' })).ok, true);
  assert.equal(JSON.stringify((await shipbay('GET', '/v1/occupancy')).locations.map((l) => [l.code, l.used])), before); await consistent();
});

test('7: a company cannot read the other\'s pallet ids or move, release or take over the other\'s pallets; weak, retired and wrong-floor keys are stopped', async () => {
  const snap = async () => JSON.stringify(await rows(`select p.external_id, l.code from nexus.occupancy o join nexus.pallets p on p.id = o.pallet_id join nexus.locations l on l.id = o.location_id order by 1`)); const before = await snap();
  // reads: every answer ShipBay can get, searched for any Souled pallet id, and the reverse
  const everything = async (s) => JSON.stringify([await s('GET', '/v1/occupancy'), await s('GET', '/v1/moves?limit=1000'), await s('GET', '/v1/changes?after=0&limit=1000'), await s('GET', '/v1/map'), await s('GET', '/v1/moves?pallet=FIX-S-0001'), await s('GET', '/v1/moves?pallet=FIX-B-0001')]);
  const b = await everything(shipbay), s = await everything(souled); assert.ok(!/FIX-S-|MVP-S-|MVP-R-\d*[13579]"/.test(b), 'ShipBay sees no Souled pallet id'); assert.ok(!/FIX-B-|MVP-B-/.test(s), 'Souled sees no ShipBay pallet id');
  assert.ok(b.includes('FIX-B-0001') && s.includes('FIX-S-0001'), 'each sees its own');
  const theirs = await shipbay('GET', '/v1/moves?pallet=FIX-S-0001', null, null, 'Asking for the other company\'s pallet history'); assert.deepEqual([theirs.status, theirs.moves], [200, []]);
  const feed = (await shipbay('GET', '/v1/changes?after=0&limit=1000')).changes.filter((c) => c.company === 'SOULED'); assert.ok(feed.length > 5 && feed.every((c) => !('pallet' in c)));
  examples.push({ note: 'Change feed as SHIPBAY sees it: its own entry carries the pallet id, the other company\'s does not', caller: 'SHIPBAY', request: 'GET /v1/changes?after=0', status: 200, response: { ok: true, changes: [(await shipbay('GET', '/v1/changes?after=0&limit=1000')).changes.find((c) => c.company === 'SHIPBAY'), feed[0], '…'], last: '<highest seq returned>' } });
  // writes on the other company's pallet: Nexus answers as if it does not exist
  const mv = await shipbay('POST', '/v1/pallets/move', { pallet: 'FIX-S-0001', to: 'P-20', from: 'P-02' }, null, 'Moving the other company\'s pallet'); assert.deepEqual([mv.status, mv.error], [404, 'pallet_not_found']);
  assert.deepEqual([(await shipbay('POST', '/v1/pallets/release', { pallet: 'FIX-S-0001' })).status, (await souled('POST', '/v1/pallets/move', { pallet: 'FIX-B-0001', to: 'P-20' })).status, (await souled('POST', '/v1/pallets/release', { pallet: 'FIX-B-0001', from: 'P-01' })).status], [404, 404, 404]);
  // the same id text used by the other company is that company's own, separate pallet: it never moves or renames the first
  const clash = await shipbay('POST', '/v1/pallets/assign', { pallet: 'FIX-S-0001', to: 'P-20' }); assert.equal(clash.ok, true); assert.deepEqual([(await at(souled, 'P-02')).your_pallets, (await at(souled, 'P-20')).your_pallets, (await at(souled, 'P-20')).occupants], [['FIX-S-0001'], [], [{ company: 'SHIPBAY', pallets: 1 }]]);
  await shipbay('POST', '/v1/pallets/release', { pallet: 'FIX-S-0001', from: 'P-20' });
  // nothing in a request can name another company or floor
  const spoof = await fetch(svc.url + '/v1/pallets/move?company=SOULED&warehouse=HILLSBOROUGH', { method: 'POST', headers: { authorization: `Bearer ${keys.shipbay}`, 'idempotency-key': 'spoof-1', 'x-company': 'SOULED', 'content-type': 'application/json' }, body: JSON.stringify({ pallet: 'FIX-S-0001', to: 'P-21', company: 'SOULED', warehouse: 'HILLSBOROUGH', company_id: SOULED }) });
  assert.equal(spoof.status, 409, 'it is treated as ShipBay\'s own (released) pallet on ShipBay\'s floor'); assert.equal((await spoof.json()).error, 'pallet_not_placed');
  // keys
  const ro = await reader('POST', '/v1/pallets/move', { pallet: 'FIX-S-0001', to: 'P-21' }, null, 'A key without the move scope'); assert.deepEqual([ro.status, ro.error], [403, 'forbidden']); assert.equal((await reader('GET', '/v1/occupancy')).ok, true);
  assert.deepEqual([(await retired('GET', '/v1/occupancy')).status, (await retired('POST', '/v1/pallets/assign', { pallet: 'X', to: 'P-21' })).status, (await sys('nxk_' + '0'.repeat(48), 'x')('GET', '/v1/map')).status, (await fetch(svc.url + '/v1/occupancy')).status], [401, 401, 401, 401]);
  const locked = await realFloor('POST', '/v1/pallets/assign', { pallet: 'REAL-1', to: 'P-03' }, null, 'Any movement on a floor that is not initialized'); assert.deepEqual([locked.status, locked.error], [423, 'occupancy_not_initialized']);
  assert.equal((await realFloor('GET', '/v1/occupancy')).locations.reduce((t, l) => t + l.used, 0), 0, 'a real-floor key sees the real floor only: empty');
  assert.equal(await snap(), before); assert.equal(await one(`select count(*)::int from nexus.pallets where warehouse = 'HILLSBOROUGH'`), 0); await consistent();
});

test('interrupted movements: a failure part-way, a dropped connection or Nexus going away leaves the pallet where it was, and the retry lands once', async () => {
  await souled('POST', '/v1/pallets/assign', { pallet: 'MVP-S-INT', to: 'P-30' }); const where = async () => (await rows(`select l.code from nexus.occupancy o join nexus.pallets p on p.id = o.pallet_id join nexus.locations l on l.id = o.location_id where p.external_id = 'MVP-S-INT'`)).map((r) => r.code);
  const state = async () => JSON.stringify([await where(), await moves(), await one(`select count(*)::int from nexus.change_log`), (await at(shipbay, 'P-30')).used, (await at(shipbay, 'P-29')).used]); const before = await state();
  // (a) the database fails after the pallet row was rewritten but before the request finished
  await db.query(`create function nexus.t_fail() returns trigger language plpgsql as 'begin raise exception ''synthetic failure''; end'; create trigger t_fail before insert on nexus.change_log for each row execute function nexus.t_fail()`);
  const half = await souled('POST', '/v1/pallets/move', { pallet: 'MVP-S-INT', to: 'P-29', from: 'P-30' }, 'souled-move-int-1', 'Nexus could not complete the request'); await db.query(`drop trigger t_fail on nexus.change_log; drop function nexus.t_fail()`);
  assert.deepEqual([half.status, half.error], [503, 'unavailable']); assert.ok(!/synthetic|change_log/.test(JSON.stringify(half))); assert.equal(await state(), before, 'nothing half-done');
  // (b) the connection carrying the request is cut while it waits its turn for the destination
  const holder = await db.connect(); await holder.query('begin'); await holder.query(`select 1 from nexus.locations where warehouse = $1 and code = 'P-29' for update`, [FLOOR]);
  const pending = souled('POST', '/v1/pallets/move', { pallet: 'MVP-S-INT', to: 'P-29', from: 'P-30' }, 'souled-move-int-1'); let pid;
  for (let i = 0; i < 100 && !pid; i++) { await new Promise((d) => setTimeout(d, 30)); pid = (await rows(`select pid from pg_stat_activity where datname = $1 and wait_event_type = 'Lock' and query like '%api_place%'`, [DBN]))[0]?.pid; }
  assert.ok(pid, 'the request is waiting'); await db.query(`select pg_terminate_backend($1)`, [pid]); const cut = await pending; await holder.query('rollback'); holder.release();
  assert.deepEqual([cut.status, cut.error], [503, 'unavailable']); assert.equal(await state(), before, 'nothing half-done');
  // (c) Nexus itself goes away and comes back
  const url = svc.url; await svc.close(); await assert.rejects(fetch(url + '/v1/occupancy', { headers: { authorization: `Bearer ${keys.souled}` } })); svc = await serve(`${base}/${DBN}`); assert.equal(await state(), before);
  // the retry, with the SAME key, lands exactly once; sending it again replays
  const retry = await souled('POST', '/v1/pallets/move', { pallet: 'MVP-S-INT', to: 'P-29', from: 'P-30' }, 'souled-move-int-1'), dup = await souled('POST', '/v1/pallets/move', { pallet: 'MVP-S-INT', to: 'P-29', from: 'P-30' }, 'souled-move-int-1');
  assert.deepEqual([retry.status, retry.ok, retry.replayed, dup.replayed, await where()], [200, true, undefined, true, ['P-29']]); assert.equal(await one(`select count(*)::int from nexus.moves where idempotency_key = 'souled-move-int-1'`), 1);
  // a caller who never saw the answer can also find out what happened
  const hist = await souled('GET', '/v1/moves?pallet=MVP-S-INT', null, null, 'What happened to my request? The caller\'s own history'); assert.deepEqual(hist.moves.map((m) => [m.kind, m.result]).sort(), [['assign', 'ok'], ['move', 'ok']]); await consistent();
});

test('10: the audit trail has one record per decided request, refusals included, never changed by later events; the fixture pallets never moved', async () => {
  const all = await rows(`select m.kind, m.result, m.external_id, m.idempotency_key, m.requester, m.at, m.response, c.code company from nexus.moves m join nexus.companies c on c.id = m.company_id order by m.id`);
  assert.ok(all.length > 60); assert.ok(all.every((m) => m.at && m.requester.startsWith('int:') && m.idempotency_key && m.response && (m.result === 'ok') === m.response.ok));
  assert.equal(new Set(all.map((m) => m.requester + '|' + m.idempotency_key)).size, all.length, 'one record per key per credential');
  for (const r of ['ok', 'location_full', 'location_not_found', 'location_not_a_destination', 'location_blocked', 'location_unavailable', 'pallet_elsewhere', 'pallet_not_placed', 'pallet_not_found', 'already_there']) assert.ok(all.some((m) => m.result === r), r);
  assert.ok(!all.some((m) => ['idempotency_key_reused', 'unavailable', 'forbidden', 'unauthorized', 'bad_request', 'occupancy_not_initialized'].includes(m.result)), 'answers that decide nothing are not recorded');
  const mine = await souled('GET', '/v1/moves?limit=1000'); assert.equal(mine.moves.length, all.filter((m) => m.company === 'SOULED').length); assert.ok(mine.moves.some((m) => m.result === 'location_full'));
  const feed = await shipbay('GET', '/v1/changes?after=0&limit=1000'); const seqs = feed.changes.map((c) => c.seq); assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b)); assert.equal(seqs.length, await one(`select count(*)::int from nexus.change_log where warehouse = $1`, [FLOOR]));
  assert.equal(feed.changes.filter((c) => /^pallet_/.test(c.kind)).length, all.filter((m) => m.result === 'ok').length, 'every accepted movement is in the feed, and nothing else is');
  assert.deepEqual([(await at(shipbay, 'P-01')).your_pallets, (await at(souled, 'P-02')).your_pallets], [['FIX-B-0001'], ['FIX-S-0001']]);
  assert.deepEqual((await rows(`select kind, result from nexus.moves where external_id in ('FIX-B-0001', 'FIX-S-0001') and result = 'ok' order by id`)).map((m) => m.kind), ['assign', 'assign', 'assign', 'release'], 'only ShipBay\'s separate same-named pallet came and went');
  await consistent();
});
