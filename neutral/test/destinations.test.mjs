// Pallets are stored only at drawn destinations (007). Throwaway local database, synthetic pallets, over real HTTP:
//   node --test neutral/test/destinations.test.mjs
import test from 'node:test'; import assert from 'node:assert/strict'; import pg from 'pg'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { serve } from '../service/server.mjs'; import { checkOccupancy } from '../client/occupancy-check.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)); const base = 'postgres://postgres@127.0.0.1:54318'; const V4 = 'be3cc8f3e9134cb4dfe7d3ac41773bc5d231ed56b4a42c05f5939467d67c8c4f';
const admin = new pg.Client(`${base}/postgres`); await admin.connect(); await admin.query('drop database if exists nexusdest'); await admin.query('create database nexusdest'); await admin.end();
const db = new pg.Pool({ connectionString: `${base}/nexusdest`, max: 30 }); const load = async (f) => db.query(fs.readFileSync(path.join(here, '..', f), 'utf8'));
const q = async (sql, p) => (await db.query(sql, p)).rows; const one = async (sql, p) => Object.values((await q(sql, p))[0])[0];
for (const f of ['001_core.sql', '002_floor_map.sql', '003_calendar.sql']) await load(f);
const TF = 'HILLSBOROUGH-TEST'; const co = (c) => one(`insert into nexus.companies (code, name) values ($1, $1) returning id`, [c]); const SOULED = await co('SOULED'), SHIPBAY = await co('SHIPBAY');
const key = (c, s) => one(`select nexus.integration_create('test', $1, $2, $3, '{read,move}')`, [c, s, TF]); const kSouled = await key(SOULED, 'souled'), kShipbay = await key(SHIPBAY, 'shipbay');
const svc = await serve(`${base}/nexusdest`); test.after(async () => { await svc.close(); await db.end(); });
let n = 0; const call = async (k, method, p, body, idem) => { const r = await fetch(svc.url + p, { method, headers: { authorization: `Bearer ${k}`, ...(body ? { 'content-type': 'application/json', 'idempotency-key': idem || `d-${++n}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { http: r.status, ...(await r.json()) }; };
const post = (k, act, body, idem) => call(k, 'POST', `/v1/pallets/${act}`, body, idem);
const at = async (code) => (await q(`select c.code || ' ' || p.external_id x from nexus.occupancy o join nexus.pallets p on p.id = o.pallet_id join nexus.companies c on c.id = p.company_id join nexus.locations l on l.id = o.location_id where l.warehouse = $1 and l.code = $2 order by 1`, [TF, code])).map((r) => r.x);
// before the rule: the floor as on staging (ShipBay at P-01) and, to stand in for history, two pallets already at the dock
assert.equal((await post(kShipbay, 'assign', { pallet: 'PSKU-000001', to: 'P-01' }, 'hist-0')).ok, true);
assert.equal((await post(kSouled, 'assign', { pallet: 'OLD-S-1', to: 'RCV-DOCK' }, 'hist-1')).ok, true, 'without the rule the dock accepts a pallet'); assert.equal((await post(kShipbay, 'assign', { pallet: 'OLD-B-1', to: 'RCV-DOCK' }, 'hist-2')).ok, true);
const mapBefore = await call(kSouled, 'GET', '/v1/map'); const historyBefore = await one(`select md5(string_agg(m::text, '|' order by id)) from nexus.moves m`);
await load('007_destinations_only.sql');

test('the map is untouched: version 4, the same checksum, the dock still listed and readable', async () => {
  const map = await call(kSouled, 'GET', '/v1/map'); assert.deepEqual([map.map_version, map.checksum], [4, V4]); assert.equal(map.checksum, mapBefore.checksum); assert.deepEqual(map.positions, mapBefore.positions);
  assert.deepEqual(map.positions.find((p) => p.code === 'RCV-DOCK'), { code: 'RCV-DOCK', kind: 'dock', zone: 'receiving', block: 'dock', col: 1, row: 1, x: null, y: null, capacity: null, status: 'open' });
  const occ = await call(kSouled, 'GET', '/v1/occupancy'); assert.equal(occ.locations.length, 69);
  assert.deepEqual((({ code, kind, used, occupants, your_pallets }) => ({ code, kind, used, occupants, your_pallets }))(occ.locations.find((l) => l.code === 'RCV-DOCK')), { code: 'RCV-DOCK', kind: 'dock', used: 2, occupants: [{ company: 'SHIPBAY', pallets: 1 }, { company: 'SOULED', pallets: 1 }], your_pallets: ['OLD-S-1'] }, 'what already stands there stays visible');
  assert.equal(await one(`select md5(string_agg(m::text, '|' order by id)) from nexus.moves m`), historyBefore, 'applying the rule rewrote no history');
});
test('assign or move into the dock is refused for either company, however the code is written, and leaves nothing behind', async () => {
  for (const k of [kSouled, kShipbay]) for (const to of ['RCV-DOCK', 'rcv-dock', '  Rcv-Dock ']) { const r = await post(k, 'assign', { pallet: `NEW-${++n}`, to }); assert.deepEqual([r.http, r.error, r.location], [409, 'location_not_a_destination', 'RCV-DOCK']); }
  assert.equal((await post(kSouled, 'assign', { pallet: 'SW-1', to: 'P-05' })).ok, true); const mv = await post(kSouled, 'move', { pallet: 'SW-1', to: 'RCV-DOCK', from: 'P-05' }); assert.deepEqual([mv.http, mv.error], [409, 'location_not_a_destination']);
  assert.deepEqual([await at('P-05'), await at('RCV-DOCK')], [['SOULED SW-1'], ['SHIPBAY OLD-B-1', 'SOULED OLD-S-1']], 'the pallet stayed where it was; the dock gained nothing');
  assert.equal((await post(kShipbay, 'move', { pallet: 'PSKU-000001', to: 'RCV-DOCK' })).error, 'location_not_a_destination'); assert.deepEqual(await at('P-01'), ['SHIPBAY PSKU-000001']);
  assert.equal((await call(kSouled, 'GET', '/v1/moves?pallet=SW-1')).moves.find((m) => m.result === 'location_not_a_destination').to, 'RCV-DOCK', 'the refusal is in the history');
});
test('retries and concurrency: a refused request stays refused under its key; forty at once place nothing', async () => {
  const a = await post(kSouled, 'assign', { pallet: 'RT-1', to: 'RCV-DOCK' }, 'rt-1'), b = await post(kSouled, 'assign', { pallet: 'RT-1', to: 'RCV-DOCK' }, 'rt-1'); assert.deepEqual([a.error, b.error, b.replayed], ['location_not_a_destination', 'location_not_a_destination', true]);
  assert.equal((await post(kSouled, 'assign', { pallet: 'RT-1', to: 'P-06' }, 'rt-1')).error, 'idempotency_key_reused', 'the same key cannot be turned into a different placement'); assert.equal((await post(kSouled, 'assign', { pallet: 'RT-1', to: 'P-06' }, 'rt-2')).ok, true);
  assert.equal(await one(`select count(*)::int from nexus.moves where idempotency_key = 'rt-1'`), 1);
  // an accepted pre-rule request replayed with its old key answers from the record and places nothing new
  const old = await post(kSouled, 'assign', { pallet: 'OLD-S-1', to: 'RCV-DOCK' }, 'hist-1'); assert.deepEqual([old.ok, old.replayed], [true, true]); assert.deepEqual(await at('RCV-DOCK'), ['SHIPBAY OLD-B-1', 'SOULED OLD-S-1']);
  const many = await Promise.all(Array.from({ length: 40 }, (_, i) => post(i % 2 ? kSouled : kShipbay, i % 4 < 2 ? 'assign' : 'move', i % 4 < 2 ? { pallet: `CC-${i}`, to: 'RCV-DOCK' } : { pallet: i % 2 ? 'SW-1' : 'PSKU-000001', to: 'RCV-DOCK' })));
  assert.deepEqual([many.filter((r) => r.ok).length, many.filter((r) => r.error === 'location_not_a_destination').length], [0, 40]); assert.deepEqual(await at('RCV-DOCK'), ['SHIPBAY OLD-B-1', 'SOULED OLD-S-1']);
});
test('no way round it: the table itself refuses, for any undrawn location, by any path', async () => {
  const dock = await one(`select id from nexus.locations where warehouse = $1 and code = 'RCV-DOCK'`, [TF]); const pid = await one(`insert into nexus.pallets (warehouse, company_id, source_system, external_id) values ($1, $2, 'direct', 'DIRECT-1') returning id`, [TF, SOULED]);
  await assert.rejects(db.query(`insert into nexus.occupancy (pallet_id, location_id, placed_by) values ($1, $2, 'direct')`, [pid, dock]), /RCV-DOCK is not a pallet storage position/);
  await assert.rejects(db.query(`update nexus.occupancy set location_id = $1 where pallet_id = (select id from nexus.pallets where external_id = 'SW-1' and warehouse = $2)`, [dock, TF]), /not a pallet storage position/);
  await assert.rejects(db.query(`insert into nexus.occupancy (pallet_id, location_id, placed_by) values ($1, $2, 'direct') on conflict (pallet_id) do update set location_id = excluded.location_id`, [await one(`select id from nexus.pallets where external_id = 'SW-1' and warehouse = $1`, [TF]), dock]), /not a pallet storage position/);
  // a position that loses its square, or a second registry-only location, is covered by the same rule with no code named anywhere
  await q(`insert into nexus.locations (code, kind, warehouse, zone, status) values ('RCV-DOCK-2', 'dock', $1, 'receiving', 'open'), ('P-99', 'pallet', $1, 'inbound', 'open')`, [TF]);
  for (const to of ['RCV-DOCK-2', 'P-99']) assert.equal((await post(kShipbay, 'assign', { pallet: `UN-${to}`, to })).error, 'location_not_a_destination', to);
  assert.equal((await post(kShipbay, 'assign', { pallet: 'UN-X', to: 'P-77' })).error, 'location_not_found');
  assert.deepEqual((await call(kSouled, 'GET', '/v1/map')).not_drawn.map((x) => x.code), ['P-99', 'RCV-DOCK-2'], 'the map names them as not drawn');
  assert.equal((await call(kSouled, 'GET', '/v1/map')).checksum, V4);
});
test('pallets already standing at the dock can be put right, by their owner only, and cannot go back', async () => {
  const seen = checkOccupancy(await call(kShipbay, 'GET', '/v1/map'), await call(kShipbay, 'GET', '/v1/occupancy')); assert.deepEqual(seen.errors.map((e) => e.code), ['occupancy_off_map_occupied'], 'both systems are told something stands where nothing should');
  assert.equal((await post(kShipbay, 'release', { pallet: 'OLD-S-1', from: 'RCV-DOCK' })).error, 'pallet_not_found', 'ShipBay cannot touch Souled\'s pallet'); assert.equal((await post(kSouled, 'move', { pallet: 'OLD-B-1', to: 'P-20' })).error, 'pallet_not_found');
  const mv = await post(kSouled, 'move', { pallet: 'OLD-S-1', to: 'P-20', from: 'RCV-DOCK' }, 'fix-1'); assert.deepEqual([mv.ok, mv.from, mv.location], [true, 'RCV-DOCK', 'P-20']); assert.equal((await post(kSouled, 'move', { pallet: 'OLD-S-1', to: 'P-20', from: 'RCV-DOCK' }, 'fix-1')).replayed, true);
  const rel = await post(kShipbay, 'release', { pallet: 'OLD-B-1', from: 'RCV-DOCK' }); assert.deepEqual([rel.ok, rel.released_from], [true, 'RCV-DOCK']);
  assert.deepEqual([await at('RCV-DOCK'), await at('P-20')], [[], ['SOULED OLD-S-1']]);
  assert.equal((await post(kSouled, 'move', { pallet: 'OLD-S-1', to: 'RCV-DOCK', from: 'P-20' })).error, 'location_not_a_destination'); assert.equal((await post(kShipbay, 'assign', { pallet: 'OLD-B-1', to: 'RCV-DOCK' })).error, 'location_not_a_destination');
  assert.equal(checkOccupancy(await call(kShipbay, 'GET', '/v1/map'), await call(kShipbay, 'GET', '/v1/occupancy')).ok, true);
});
test('everything else is as before: drawn positions, staging, conflicts, one winner in a race, company isolation, the feed', async () => {
  assert.equal((await post(kSouled, 'assign', { pallet: 'OK-1', to: 'P-30' })).free, 0); assert.equal((await post(kShipbay, 'assign', { pallet: 'OK-2', to: 'P-30' })).error, 'location_full');
  assert.equal((await post(kShipbay, 'assign', { pallet: 'OK-2', to: 'STG-02' })).ok, true); assert.equal((await post(kShipbay, 'move', { pallet: 'OK-2', to: 'P-66', from: 'STG-02' })).location, 'P-66');
  const race = await Promise.all(Array.from({ length: 20 }, (_, i) => post(i % 2 ? kSouled : kShipbay, 'assign', { pallet: `RACE-${i}`, to: 'P-40' }))); assert.deepEqual([race.filter((r) => r.ok).length, race.filter((r) => r.error === 'location_full').length], [1, 19]);
  assert.equal((await post(kShipbay, 'move', { pallet: 'OK-1', to: 'P-31' })).error, 'pallet_not_found'); assert.deepEqual(await at('P-01'), ['SHIPBAY PSKU-000001'], 'the standing ShipBay pallet was never moved');
  const feed = await call(kShipbay, 'GET', '/v1/changes?after=0&limit=1000'); assert.ok(feed.changes.filter((c) => c.company === 'SOULED').every((c) => !('pallet' in c))); assert.ok(!feed.changes.some((c) => c.location === 'RCV-DOCK' && c.seq > 3 && c.kind !== 'pallet_moved' && c.kind !== 'pallet_released'), 'nothing was ever placed at the dock after the rule');
  assert.equal(await one(`select count(*)::int from (select requester, idempotency_key from nexus.moves group by 1, 2 having count(*) > 1) d`), 0);
});
