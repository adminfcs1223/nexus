// Stage 2 shared RECEIVING / OUTBOUND zone on a throwaway local database (everything deployed, then 014): `node --test neutral/test/shared-zone.test.mjs`
import test from 'node:test'; import assert from 'node:assert/strict'; import pg from 'pg'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { serve } from '../service/server.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)); const base = 'postgres://postgres@127.0.0.1:54318'; const DBN = 'nexuszone'; const REAL = 'HILLSBOROUGH', Z = 'RCV-OUT';
const boot = new pg.Client(`${base}/postgres`); await boot.connect(); await boot.query(`drop database if exists ${DBN}`); await boot.query(`create database ${DBN}`); await boot.end();
const db = new pg.Pool({ connectionString: `${base}/${DBN}` }); const load = async (f) => db.query(fs.readFileSync(path.join(here, '..', f), 'utf8'));
for (const f of ['001_core.sql', '002_floor_map.sql', '003_calendar.sql', '004_baseline.sql', '005_key_handoff.sql', '007_destinations_only.sql', '010_forward_only.sql', '011_retire_floor.sql', '012_site_view.sql', '013_credential_rotation.sql']) await load(f);
const one = async (sql, p) => Object.values((await db.query(sql, p)).rows[0])[0]; const rows = async (sql, p) => (await db.query(sql, p)).rows;
const SOULED = await one(`insert into nexus.companies (code, name) values ('SOULED', 'Souled Worldwide') returning id`), SHIPBAY = await one(`insert into nexus.companies (code, name) values ('SHIPBAY', 'ShipBay3PL') returning id`);
await one(`select nexus.floor_open_forward_only('t', $1, 'local test fixture only')`, [REAL]);
const key = (c, sys, scopes) => one(`select nexus.integration_create('test', $1, $2, $3, $4)`, [c, sys, REAL, scopes]);
const k = { souled: await key(SOULED, 's-prod', ['read', 'move']), shipbay: await key(SHIPBAY, 'b-prod', ['read', 'move']), sRead: await key(SOULED, 's-read', ['read']) };
// Stage 1 as it runs today: a pallet of each company on the floor, placed before the change with keys the test will replay
const svc0 = await serve(`${base}/${DBN}`); let n = 0;
const mk = (svc) => (kk) => async (method, p, body, idem) => { const r = await fetch(svc.url + p, { method, headers: { authorization: `Bearer ${kk}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(method === 'POST' ? { 'idempotency-key': idem || `z-${++n}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { ...(await r.json()), status: r.status }; };
const OK = { confirmed_empty: true, confirmed_by: 'J. Rivera' };
assert.equal((await mk(svc0)(k.souled)('POST', '/v1/pallets/assign', { pallet: 'S-OLD', to: 'P-65', ...OK }, 'old-s')).ok, true);
assert.equal((await mk(svc0)(k.shipbay)('POST', '/v1/pallets/assign', { pallet: 'B-OLD', to: 'P-01', ...OK }, 'old-b')).ok, true);
const before = { map: await mk(svc0)(k.souled)('GET', '/v1/map'), occ: await mk(svc0)(k.souled)('GET', '/v1/occupancy'), moves: await rows(`select id, kind, external_id, result, response, request, confirmation from nexus.moves order by id`) }; await svc0.close();
await load('014_shared_zone.sql'); await load('014_shared_zone.sql');   // twice: applying it again changes nothing
const svc = await serve(`${base}/${DBN}`); const sys = mk(svc); const souled = sys(k.souled), shipbay = sys(k.shipbay), sRead = sys(k.sRead);
test.after(async () => { await svc.close(); await db.end(); });
const at = async (s, code) => (await s('GET', '/v1/occupancy')).locations.find((l) => l.code === code);

test('the map: one new location, and every existing position exactly as it was', async () => {
  const m = await souled('GET', '/v1/map'); const z = m.positions.find((p) => p.code === Z);
  assert.deepEqual([m.map_version, m.positions.length, m.positions.filter((p) => p.kind === 'pallet').length, m.positions.filter((p) => p.kind === 'staging').length], [5, 70, 66, 2]);
  assert.deepEqual([z.kind, z.zone, z.block, z.capacity, z.status, z.x, z.y], ['zone', 'receiving_outbound', 'receiving_outbound', null, 'open', null, null]);
  assert.deepEqual(m.positions.filter((p) => p.code !== Z), before.map.positions, 'P-01..P-66, STG-01, STG-02 and the dock are byte-for-byte unchanged');
  assert.notEqual(m.checksum, before.map.checksum); assert.deepEqual(m.landmarks, before.map.landmarks);
  const b = m.layout.blocks.find((x) => x.key === 'receiving_outbound'); assert.deepEqual([b.x, b.y, b.location, b.shared, m.layout.grid.top_rows, m.layout.grid.rows, m.layout.grid.cols], [[1, 2], [-2, 0], Z, true, 3, 18, 5]);
  assert.deepEqual(m.layout.blocks.filter((x) => x.key !== 'receiving_outbound'), before.map.layout.blocks);
  assert.equal((await rows(`select count(*)::int n from nexus.locations where code = $1`, [Z]))[0].n, 1);
  assert.deepEqual(await rows(`select id, kind, external_id, result, response, request, confirmation from nexus.moves where id <= $1 order by id`, [before.moves.at(-1).id]), before.moves, 'movement history untouched');
  assert.deepEqual((await souled('GET', '/v1/occupancy')).locations.filter((l) => l.code !== Z).map(({ updated_at, ...l }) => l), before.occ.locations.map(({ updated_at, ...l }) => l), 'existing occupancy answers exactly as before');
});
test('entering the zone needs inbound or outbound, not an empty-position confirmation; nothing is recorded until it is given', async () => {
  const c0 = await one(`select count(*)::int from nexus.moves`);
  for (const extra of [{}, OK, { zone_status: '' }, { zone_status: 'staged' }, { zone_status: true }, { zone_status: null }]) {
    const r = await souled('POST', '/v1/pallets/assign', { pallet: 'S-IN-1', to: Z, ...extra }, 'zin-1'); assert.deepEqual([r.status, r.error], [400, 'zone_status_required'], JSON.stringify(extra));
  }
  assert.equal(await one(`select count(*)::int from nexus.moves`), c0);
  assert.equal((await one(`select nexus.place('x', $1, $2, 's', 'assign', 'S-IN-1', $3, null, 'direct-z')`, [REAL, SOULED, Z])).error, 'zone_status_required', 'also when the engine is called directly');
  const r = await souled('POST', '/v1/pallets/assign', { pallet: 'S-IN-1', to: Z, zone_status: 'inbound' }, 'zin-1'); assert.deepEqual([r.status, r.ok, r.location, r.zone_status, r.free, r.from], [200, true, Z, 'inbound', null, null]);
  assert.equal((await souled('POST', '/v1/pallets/assign', { pallet: 'S-IN-1', to: Z, zone_status: 'inbound' }, 'zin-1')).replayed, true);
  assert.equal((await souled('POST', '/v1/pallets/assign', { pallet: 'S-IN-1', to: Z, zone_status: 'outbound' }, 'zin-1')).error, 'idempotency_key_reused');
  const rec = (await rows(`select confirmation c from nexus.moves where idempotency_key = 'zin-1'`))[0].c; assert.deepEqual([rec.zone_status, rec.location, rec.by, rec.empty], ['inbound', Z, undefined, undefined]);
  assert.equal((await sRead('POST', '/v1/pallets/assign', { pallet: 'S-X', to: Z, zone_status: 'inbound' })).status, 403, 'a read key still cannot move');
});
test('both companies stand there at once, with no limit, each seeing only its own pallet ids', async () => {
  for (let i = 1; i <= 8; i += 1) assert.equal((await shipbay('POST', '/v1/pallets/assign', { pallet: `B-Z-${i}`, to: Z, zone_status: i % 2 ? 'inbound' : 'outbound', confirmed_by: 'M. Diaz' })).ok, true, `ShipBay pallet ${i} (past the six-position footprint)`);
  assert.equal((await souled('POST', '/v1/pallets/assign', { pallet: 'B-Z-1', to: Z, zone_status: 'outbound' })).ok, true, 'the same id from the other company is a different pallet');
  const s = await at(souled, Z), b = await at(shipbay, Z);
  assert.deepEqual([s.kind, s.shared, s.capacity, s.free, s.used], ['zone', true, null, null, 10]);
  assert.deepEqual(s.occupants, [{ company: 'SHIPBAY', pallets: 8, inbound: 4, outbound: 4 }, { company: 'SOULED', pallets: 2, inbound: 1, outbound: 1 }]); assert.deepEqual(b.occupants, s.occupants);
  assert.deepEqual(s.your_pallets, ['S-IN-1', 'B-Z-1']); assert.deepEqual(s.your_pallets_status.map((x) => [x.pallet, x.zone_status]), [['S-IN-1', 'inbound'], ['B-Z-1', 'outbound']]);
  assert.equal(b.your_pallets.length, 8); assert.ok(!JSON.stringify(b).includes('S-IN-1') && !JSON.stringify(await shipbay('GET', '/v1/changes?after=0')).includes('S-IN-1') && !JSON.stringify(await shipbay('GET', '/v1/moves')).includes('S-IN-1'));
  assert.equal((await rows(`select confirmation ->> 'by' b from nexus.moves where external_id = 'B-Z-1' and company_id = $1`, [SHIPBAY]))[0].b, 'M. Diaz', 'who handled it is kept when sent');
  const p = await at(souled, 'P-65'); assert.ok(!('shared' in p) && !('your_pallets_status' in p) && !('inbound' in p.occupants[0]), 'ordinary positions carry none of the zone fields');
});
test('movements in and out go through the same engine: zone to rack, rack to zone, status change, release', async () => {
  let r = await souled('POST', '/v1/pallets/move', { pallet: 'S-IN-1', to: 'P-40', from: Z }); assert.deepEqual([r.status, r.error], [400, 'location_not_confirmed'], 'a numbered position still needs its empty confirmation');
  r = await souled('POST', '/v1/pallets/move', { pallet: 'S-IN-1', to: 'P-40', from: Z, ...OK }); assert.deepEqual([r.ok, r.location, r.from, r.free, 'zone_status' in r], [true, 'P-40', Z, 0, false]);
  assert.equal(await one(`select flow from nexus.occupancy o join nexus.pallets p on p.id = o.pallet_id where p.external_id = 'S-IN-1'`), null, 'the status belongs to the zone, not the rack');
  r = await souled('POST', '/v1/pallets/move', { pallet: 'S-OLD', to: Z, from: 'P-65', zone_status: 'outbound' }); assert.deepEqual([r.ok, r.location, r.from, r.zone_status], [true, Z, 'P-65', 'outbound']);
  assert.equal((await at(shipbay, 'P-65')).used, 0, 'the position it left is open again for either company');
  r = await souled('POST', '/v1/pallets/move', { pallet: 'S-OLD', to: Z, from: Z, zone_status: 'outbound' }); assert.equal(r.error, 'already_there');
  r = await souled('POST', '/v1/pallets/move', { pallet: 'B-Z-1', to: Z, from: Z, zone_status: 'inbound' }); assert.deepEqual([r.ok, r.status_changed, r.zone_status, r.location], [true, true, 'inbound', Z]);
  assert.equal((await at(souled, Z)).your_pallets_status.find((x) => x.pallet === 'B-Z-1').zone_status, 'inbound');
  r = await souled('POST', '/v1/pallets/move', { pallet: 'S-OLD', to: 'P-10', from: 'STG-01', ...OK }); assert.equal(r.error, 'pallet_elsewhere', 'the stated source is still checked');
  r = await shipbay('POST', '/v1/pallets/release', { pallet: 'S-OLD', from: Z }); assert.equal(r.error, 'pallet_not_found', 'one company cannot release the other company\'s pallet');
  r = await souled('POST', '/v1/pallets/release', { pallet: 'S-OLD', from: Z }); assert.deepEqual([r.ok, r.released_from], [true, Z]);
  const h = (await souled('GET', '/v1/moves?pallet=S-OLD')).moves.map((m) => [m.kind, m.from, m.to, m.result, m.zone_status]);
  assert.deepEqual(h, [['release', Z, null, 'ok', undefined], ['move', Z, null, 'pallet_elsewhere', undefined], ['move', Z, Z, 'already_there', 'outbound'], ['move', 'P-65', Z, 'ok', 'outbound'], ['assign', null, 'P-65', 'ok', undefined]], 'one pallet, one continuous history');
});
test('conflict prevention on numbered positions and staging is unchanged', async () => {
  let r = await souled('POST', '/v1/pallets/move', { pallet: 'B-Z-1', to: 'P-01', from: Z, ...OK }); assert.deepEqual([r.status, r.error, r.capacity, r.used], [409, 'location_full', 1, 1]);
  r = await shipbay('POST', '/v1/pallets/move', { pallet: 'B-Z-2', to: 'P-40', from: Z, ...OK }); assert.equal(r.error, 'location_full', 'Souled holds P-40');
  r = await shipbay('POST', '/v1/pallets/assign', { pallet: 'B-D', to: 'RCV-DOCK', zone_status: 'inbound', ...OK }); assert.equal(r.error, 'location_not_a_destination', 'the dock is still not a storage location');
  r = await shipbay('POST', '/v1/pallets/assign', { pallet: 'B-STG', to: 'STG-01' }); assert.equal(r.error, 'location_not_confirmed');
  r = await shipbay('POST', '/v1/pallets/assign', { pallet: 'B-STG', to: 'STG-01', zone_status: 'inbound', ...OK }); assert.deepEqual([r.ok, 'zone_status' in r], [true, false], 'zone_status is ignored outside the zone');
  assert.equal((await shipbay('POST', '/v1/pallets/assign', { pallet: 'B-OLD', to: 'P-01', ...OK }, 'old-b')).replayed, true, 'a key recorded before the change still replays');
  await assert.rejects(db.query(`insert into nexus.occupancy (pallet_id, location_id, placed_by) select p.id, l.id, 'x' from nexus.pallets p, nexus.locations l where p.external_id = 'B-D' and l.code = $1 and l.warehouse = $2`, [Z, REAL]), /needs an inbound or outbound status/);
  await db.query(`update nexus.locations set status = 'unavailable', status_reason = 'closed for cleaning' where code = $1 and warehouse = $2`, [Z, REAL]);
  r = await shipbay('POST', '/v1/pallets/assign', { pallet: 'B-D', to: Z, zone_status: 'inbound' }); assert.equal(r.error, 'location_unavailable', 'the zone can be switched off like any location');
  r = await shipbay('POST', '/v1/pallets/release', { pallet: 'B-Z-3', from: Z }); assert.equal(r.ok, true, 'and pallets can still leave it');
  await db.query(`update nexus.locations set status = 'open', status_reason = null where code = $1 and warehouse = $2`, [Z, REAL]);
});
test('the website view shows the zone by company and status only', async () => {
  const v = await one(`select nexus.site_overview($1)`, [REAL]); const z = v.positions.find((p) => p.code === Z);
  assert.deepEqual([v.map_version, z.kind, z.used], [5, 'zone', 8]); assert.deepEqual(z.occupants.map((o) => [o.company, o.pallets, o.inbound, o.outbound]), [['SHIPBAY', 7, 3, 4], ['SOULED', 1, 1, 0]]);
  assert.deepEqual([...new Set(v.pallets.filter((p) => p.location === Z).map((p) => p.zone_status))].sort(), ['inbound', 'outbound']); assert.ok(!/B-Z-|S-IN|M\. Diaz|J\. Rivera/.test(JSON.stringify(v)));
});
