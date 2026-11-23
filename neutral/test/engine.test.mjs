// The neutral Nexus foundation on a throwaway local database (127.0.0.1 only): `node --test neutral/test/engine.test.mjs`.
// Covers the brief's occupancy cases: 1-8, 15-17 (through the functions the HTTP layer will map onto) and 18.
import test from 'node:test'; import assert from 'node:assert/strict'; import pg from 'pg'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)); const base = 'postgres://postgres@127.0.0.1:54318';
const admin = new pg.Client(`${base}/postgres`); await admin.connect(); await admin.query('drop database if exists nexusneutral'); await admin.query('create database nexusneutral'); await admin.end();
const pool = new pg.Pool({ connectionString: `${base}/nexusneutral`, max: 30 });
for (const f of ['001_core.sql', '002_floor_map.sql', '003_calendar.sql', ...(process.env.NEXUS_WITH || '').split(',').filter(Boolean)]) await pool.query(fs.readFileSync(path.join(here, '..', f), 'utf8'));
const q = async (sql, p) => (await pool.query(sql, p)).rows; const one = async (sql, p) => Object.values((await q(sql, p))[0])[0];
const co = async (code, name) => one(`insert into nexus.companies (code, name) values ($1, $2) returning id`, [code, name]);
const SOULED = await co('SOULED', 'Souled Worldwide'), SHIPBAY = await co('SHIPBAY', 'ShipBay3PL');
const key = (c, sys, scopes, wh = 'HILLSBOROUGH-TEST') => one(`select nexus.integration_create('test', $1, $2, $3, $4)`, [c, sys, wh, scopes]);
const kSouled = await key(SOULED, 'souled-wms', ['read', 'move']), kShipbay = await key(SHIPBAY, 'shipbay-wms', ['read', 'move']), kReadOnly = await key(SHIPBAY, 'shipbay-dashboard', ['read']);
let n = 0; const place = (k, kind, pallet, to, from = null, idem = `t-${++n}`) => one(`select nexus.api_place($1, $2, $3, $4, $5, $6)`, [k, kind, pallet, to, from, idem]);
const occ = async (k, code) => (await one(`select nexus.api_occupancy($1)`, [k])).locations.find((l) => l.code === code);
test.after(() => pool.end());
const run = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => `P-${String(a + i).padStart(2, '0')}`);

test('the final approved map: P-01..P-66 with no gaps, 2 staging, each in its physical square, on both floors', async () => {
  for (const wh of ['HILLSBOROUGH', 'HILLSBOROUGH-TEST']) {
    const r = (await q(`select kind, status, count(*)::int n from nexus.locations where warehouse = $1 group by 1, 2 order by 1, 2`, [wh])).map((x) => `${x.kind}/${x.status}/${x.n}`);
    assert.deepEqual(r, ['dock/open/1', 'pallet/open/66', 'staging/open/2'], 'no inactive or extra pallet codes');
    assert.deepEqual((await q(`select code from nexus.locations where warehouse = $1 and kind = 'pallet' order by code`, [wh])).map((x) => x.code), run(1, 66), '66 unique consecutive codes');
    const line = async (x) => (await q(`select code from nexus.locations where warehouse = $1 and map_x = $2 and kind = 'pallet' order by map_y`, [wh, x])).map((c) => c.code);
    assert.deepEqual(await line(1), run(31, 48)); assert.deepEqual(await line(2), run(49, 66)); assert.deepEqual(await line(3), [], 'the walkway holds nothing');
    assert.deepEqual(await line(4), run(1, 15)); assert.deepEqual(await line(5), run(16, 30));
    const y = async (code) => one(`select map_y from nexus.locations where warehouse = $1 and code = $2`, [wh, code]);
    assert.deepEqual([await y('P-01'), await y('P-15'), await y('P-16'), await y('P-30'), await y('P-31'), await y('P-48'), await y('P-49'), await y('P-66')], [1, 15, 1, 15, 1, 18, 1, 18], 'every column runs top to bottom');
    assert.deepEqual((await q(`select code, map_x, map_y from nexus.locations where warehouse = $1 and kind = 'staging' order by code`, [wh])), [{ code: 'STG-01', map_x: 4, map_y: 16 }, { code: 'STG-02', map_x: 5, map_y: 16 }], 'staging directly beneath P-15 and P-30');
    assert.equal(await one(`select count(*)::int from (select map_x, map_y from nexus.locations where warehouse = $1 and map_x is not null group by 1, 2 having count(*) > 1) d`, [wh]), 0, 'no two locations share a square');
  }
});
test('the live floor starts with nothing on it, says so, and refuses assign / move / release; reading still works', async () => {
  const live = await key(SHIPBAY, 'shipbay-wms', ['read', 'move', 'calendar'], 'HILLSBOROUGH');
  const o = await one(`select nexus.api_occupancy($1)`, [live]);
  assert.deepEqual([o.warehouse, o.test, o.occupancy_state, o.moves_enabled], ['HILLSBOROUGH', false, 'not_initialized', false]);
  assert.equal(o.locations.length, 69); assert.ok(o.locations.every((l) => l.used === 0 && l.occupants.length === 0));
  for (const [kind, to] of [['assign', 'P-01'], ['move', 'P-02'], ['release', null]]) {
    const r = await one(`select nexus.api_place($1, $2, 'PSKU-000001', $3, null, $4)`, [live, kind, to, `live-${kind}`]); assert.deepEqual([r.ok, r.error, r.occupancy_state], [false, 'occupancy_not_initialized', 'not_initialized']);
  }
  assert.deepEqual(await q(`select 1 from nexus.occupancy o join nexus.locations l on l.id = o.location_id where l.warehouse = 'HILLSBOROUGH'`), []);
  assert.deepEqual(await q(`select 1 from nexus.pallets where warehouse = 'HILLSBOROUGH'`), [], 'not even a pallet record was made');
  await assert.rejects(pool.query(`update nexus.warehouses set moves_enabled = true where code = 'HILLSBOROUGH'`), /check/, 'the database itself refuses to switch moves on before the baseline is verified');
  const mapLive = await one(`select nexus.api_map($1)`, [live]), mapTest = await one(`select nexus.api_map($1)`, [kSouled]);
  assert.equal(mapLive.checksum, mapTest.checksum, 'the test floor draws exactly the live floor'); assert.equal(mapLive.positions.length, 69); assert.equal(mapLive.not_drawn.length, 0); assert.equal(mapLive.map_version, 4);
  assert.deepEqual(mapLive.layout.grid, { cols: 5, rows: 18, origin: 'top-left', x: 'left to right', y: 'top to bottom' });
  assert.deepEqual(mapLive.landmarks.map((l) => `${l.key}:${l.at}`), ['exit:top-left', 'dock:top-right', 'walkway:centre', 'entrance:bottom-centre', 'prep:bottom-right']);
});
test('1-3: Souled assigns a pallet; ShipBay sees the position taken by Souled and cannot take it', async () => {
  const r = await place(kSouled, 'assign', 'SW-0001', 'P-01'); assert.equal(r.ok, true); assert.equal(r.free, 0);
  const seen = await occ(kShipbay, 'P-01'); assert.deepEqual([seen.used, seen.free, seen.occupants, seen.your_pallets], [1, 0, [{ company: 'SOULED', pallets: 1 }], []], 'company and count only: no pallet id');
  assert.deepEqual((await occ(kSouled, 'P-01')).your_pallets, ['SW-0001']);
  const clash = await place(kShipbay, 'assign', 'PSKU-000900', 'P-01'); assert.deepEqual([clash.ok, clash.error, clash.used], [false, 'location_full', 1]);
  assert.equal((await occ(kShipbay, 'P-01')).used, 1, 'the refusal changed nothing');
});
test('4-5: Souled moves it; both see the new place and the old one free', async () => {
  const r = await place(kSouled, 'move', 'SW-0001', 'P-02', 'P-01'); assert.deepEqual([r.ok, r.from, r.location], [true, 'P-01', 'P-02']);
  assert.equal((await occ(kShipbay, 'P-01')).used, 0); assert.deepEqual((await occ(kShipbay, 'P-02')).occupants, [{ company: 'SOULED', pallets: 1 }]);
});
test('6: the same request twice makes one move', async () => {
  const a = await place(kSouled, 'move', 'SW-0001', 'P-03', null, 'dup-1'), b = await place(kSouled, 'move', 'SW-0001', 'P-03', null, 'dup-1');
  assert.equal(a.ok, true); assert.deepEqual([b.ok, b.replayed, b.seq], [true, true, a.seq]);
  assert.equal(await one(`select count(*)::int from nexus.moves where idempotency_key = 'dup-1'`), 1);
  const reused = await place(kSouled, 'move', 'SW-0002', 'P-04', null, 'dup-1'); assert.equal(reused.error, 'idempotency_key_reused');
  const same = await Promise.all(Array.from({ length: 10 }, () => place(kSouled, 'assign', 'SW-0050', 'P-50', null, 'dup-2')));
  assert.equal(same.filter((x) => x.ok && !x.replayed).length, 1, 'ten copies at the same moment: one does the work'); assert.equal(same.filter((x) => x.replayed).length, 9);
});
test('7: twenty simultaneous assignments from both companies cannot overfill one position', async () => {
  const all = await Promise.all(Array.from({ length: 20 }, (_, i) => place(i % 2 ? kSouled : kShipbay, 'assign', `RACE-${i}`, 'P-10')));
  assert.equal(all.filter((x) => x.ok).length, 1); assert.equal(all.filter((x) => x.error === 'location_full').length, 19);
  assert.equal(await one(`select count(*)::int from nexus.occupancy o join nexus.locations l on l.id = o.location_id where l.code = 'P-10'`), 1);
  const moves = await Promise.all(['SW-0001', 'SW-0050'].map((p) => place(kSouled, 'move', p, 'P-11')));
  assert.equal(moves.filter((x) => x.ok).length, 1, 'two pallets moved to one position at once: one arrives');
});
test('8: a failed move leaves the pallet where it was', async () => {
  const where = async () => one(`select l.code from nexus.occupancy o join nexus.locations l on l.id = o.location_id join nexus.pallets p on p.id = o.pallet_id where p.external_id = 'SW-0001' and p.company_id = $1 and p.warehouse = 'HILLSBOROUGH-TEST'`, [SOULED]);
  const before = await where();
  await one(`select nexus.location_set('admin:test', 'HILLSBOROUGH-TEST', 'P-66', 'unavailable', 'Closed for the test', null)`);
  assert.equal((await place(kSouled, 'move', 'SW-0001', 'P-66')).error, 'location_unavailable'); assert.equal((await place(kSouled, 'move', 'SW-0001', 'P-67')).error, 'location_not_found', 'there is no P-67'); assert.equal((await place(kSouled, 'move', 'SW-0001', 'NOPE-1')).error, 'location_not_found');
  assert.equal((await place(kSouled, 'move', 'SW-0001', 'P-20', 'P-33')).error, 'pallet_elsewhere', 'stale: the caller thought it was somewhere else');
  assert.equal(await where(), before);
});
test('capacity and blocking: staging is not limited; a blocked location refuses; capacity never drops below what stands there', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await place(kShipbay, 'assign', `STG-${i}`, 'STG-01')).ok, true);
  assert.deepEqual((await occ(kSouled, 'STG-01')).occupants, [{ company: 'SHIPBAY', pallets: 5 }]);
  assert.equal((await one(`select nexus.location_set('admin:test', 'HILLSBOROUGH-TEST', 'STG-01', null, null, 3)`)).error, 'capacity_below_occupancy');
  await one(`select nexus.location_set('admin:test', 'HILLSBOROUGH-TEST', 'P-30', 'blocked', 'Leak from the roof', null)`);
  const r = await place(kSouled, 'assign', 'SW-0100', 'P-30'); assert.deepEqual([r.error, r.message], ['location_blocked', 'Leak from the roof']);
  await one(`select nexus.location_set('admin:test', 'HILLSBOROUGH-TEST', 'P-30', 'open', null, 2)`); assert.equal((await place(kSouled, 'assign', 'SW-0100', 'P-30', null, 'retry-new-key')).free, 1);
  assert.equal((await place(kShipbay, 'assign', 'PSKU-000901', 'P-30')).free, 0, 'a position can be shared when its capacity allows');
});
test('release frees the position; the pallet can be assigned again later', async () => {
  const r = await place(kShipbay, 'release', 'PSKU-000901', null, 'P-30'); assert.deepEqual([r.ok, r.released_from], [true, 'P-30']);
  assert.equal((await place(kShipbay, 'release', 'PSKU-000901', null)).error, 'pallet_not_placed'); assert.equal((await place(kShipbay, 'assign', 'PSKU-000901', 'P-31')).ok, true);
});
test('16-17: a company cannot touch the other\'s pallet, and a key without the move scope cannot move anything', async () => {
  assert.equal((await place(kShipbay, 'move', 'SW-0001', 'P-40')).error, 'pallet_not_found', 'the id only resolves inside the caller\'s own company');
  assert.equal((await place(kShipbay, 'release', 'SW-0001', null)).error, 'pallet_not_found');
  assert.equal((await place(kReadOnly, 'assign', 'PSKU-000950', 'P-41')).error, 'forbidden'); assert.equal((await place('nxk_wrong', 'assign', 'X', 'P-41')).error, 'unauthorized');
  assert.equal((await place(kShipbay, 'assign', 'SW-0001', 'P-42')).ok, true, 'the same id under another company is a different pallet');
  assert.equal(await one(`select count(*)::int from nexus.pallets where external_id = 'SW-0001'`), 2);
  const cols = (await q(`select table_name || '.' || column_name c from information_schema.columns where table_schema = 'nexus'`)).map((x) => x.c).join(' ');
  assert.ok(!/sku|qty|quantity|item|product|cost|customer|carton/i.test(cols), 'no column in Nexus can hold product, quantity, cost or customer detail');
});
test('15 and 18: after an outage a system catches up from the feed, and every request has a history row', async () => {
  const mine = await one(`select nexus.api_changes($1, 0, 1000)`, [kSouled]); assert.ok(mine.changes.length >= 15);
  assert.ok(mine.changes.filter((c) => c.company === 'SHIPBAY').every((c) => !('pallet' in c)), 'the other company\'s changes carry no pallet id');
  assert.ok(mine.changes.filter((c) => c.company === 'SOULED' && c.kind !== 'location_changed').every((c) => c.pallet));
  const page = await one(`select nexus.api_changes($1, 0, 5)`, [kSouled]); const rest = await one(`select nexus.api_changes($1, $2, 1000)`, [kSouled, page.last]);
  assert.equal(page.changes.length + rest.changes.length, mine.changes.length, 'paging by the last number misses nothing'); assert.deepEqual((await one(`select nexus.api_changes($1, $2)`, [kSouled, mine.last])).changes, []);
  const hist = await one(`select nexus.api_moves($1, 'SW-0001')`, [kSouled]); assert.ok(hist.moves.some((m) => m.result === 'location_unavailable') && hist.moves.some((m) => m.result === 'ok'), 'refused requests are kept too');
  assert.ok((await one(`select count(*)::int from nexus.audit_log where action in ('integration_created', 'location_changed')`)) >= 5);
});
test('after every synthetic test the live floor is still empty and its feed is silent', async () => {
  assert.equal(await one(`select count(*)::int from nexus.occupancy o join nexus.locations l on l.id = o.location_id where l.warehouse = 'HILLSBOROUGH'`), 0);
  assert.equal(await one(`select count(*)::int from nexus.change_log where warehouse = 'HILLSBOROUGH'`), 0); assert.equal(await one(`select count(*)::int from nexus.moves where warehouse = 'HILLSBOROUGH'`), 0);
});
test('idempotency covers every position named: same key replays only the identical request', async () => {
  const k = await key(SOULED, 'souled-idem', ['read', 'move']); const go = (kind, pallet, to, from, idem) => one(`select nexus.api_place($1, $2, $3, $4, $5, $6)`, [k, kind, pallet, to, from, idem]);
  const at = async (p) => (await q(`select l.code from nexus.occupancy o join nexus.locations l on l.id = o.location_id join nexus.pallets x on x.id = o.pallet_id where x.external_id = $1 and x.company_id = $2 and x.warehouse = 'HILLSBOROUGH-TEST'`, [p, SOULED]))[0]?.code ?? null;
  const n = () => one(`select count(*)::int from nexus.moves where idempotency_key like 'idm-%'`);
  // assign
  const a = await go('assign', 'IDM-1', 'P-60', null, 'idm-a'); assert.equal(a.ok, true);
  assert.deepEqual([(await go('assign', 'IDM-1', ' p-60 ', null, 'idm-a')).replayed, (await go('assign', 'IDM-1', 'P-60', 'P-01', 'idm-a')).replayed], [true, true], 'identical (case, spaces and an unused from aside): replayed');
  for (const [kind, pallet, to, from, why] of [['assign', 'IDM-1', 'P-61', null, 'different destination'], ['assign', 'IDM-2', 'P-60', null, 'different pallet'], ['move', 'IDM-1', 'P-60', null, 'different action']])
    assert.equal((await go(kind, pallet, to, from, 'idm-a')).error, 'idempotency_key_reused', why);
  assert.equal(await at('IDM-1'), 'P-60'); assert.equal(await at('IDM-2'), null);
  // move
  const m = await go('move', 'IDM-1', 'P-61', 'P-60', 'idm-m'); assert.deepEqual([m.ok, m.location], [true, 'P-61']);
  const rm = await go('move', 'IDM-1', 'P-61', 'P-60', 'idm-m'); assert.deepEqual([rm.replayed, rm.seq], [true, m.seq]);
  for (const [to, from, why] of [['P-62', 'P-60', 'different destination'], ['P-61', 'P-59', 'different source'], ['P-61', null, 'source left out'], [null, 'P-60', 'destination left out']])
    assert.equal((await go('move', 'IDM-1', to, from, 'idm-m')).error, 'idempotency_key_reused', why);
  assert.equal(await at('IDM-1'), 'P-61', 'none of the mismatched requests moved it');
  // a refusal stays a refusal for its key; a new key is a new attempt
  await go('assign', 'IDM-3', 'P-62', null, 'idm-b');
  const full = await go('assign', 'IDM-4', 'P-62', null, 'idm-full'); assert.equal(full.error, 'location_full');
  await go('release', 'IDM-3', null, 'P-62', 'idm-r');
  const again = await go('assign', 'IDM-4', 'P-62', null, 'idm-full'); assert.deepEqual([again.error, again.replayed], ['location_full', true], 'the position is free now, the old key still answers no');
  assert.equal((await go('assign', 'IDM-4', 'P-63', null, 'idm-full')).error, 'idempotency_key_reused'); assert.equal(await at('IDM-4'), null);
  assert.equal((await go('assign', 'IDM-4', 'P-62', null, 'idm-new')).ok, true);
  // release
  const rr = await go('release', 'IDM-3', null, 'P-62', 'idm-r'); assert.deepEqual([rr.replayed, rr.released_from], [true, 'P-62']);
  assert.equal((await go('release', 'IDM-3', null, 'P-01', 'idm-r')).error, 'idempotency_key_reused', 'different source'); assert.equal((await go('release', 'IDM-3', null, null, 'idm-r')).error, 'idempotency_key_reused', 'source left out');
  assert.equal((await go('release', 'IDM-3', 'P-10', 'P-62', 'idm-r')).replayed, true, 'a destination means nothing to a release');
  assert.equal(await n(), 6, 'one history row per key; mismatches and replays add none');
  // a row written before this rule (no request stored) keeps the earlier matching
  await pool.query(`update nexus.moves set request = null where idempotency_key = 'idm-m'`);
  assert.equal((await go('move', 'IDM-1', 'P-62', null, 'idm-m')).replayed, true); assert.equal((await go('move', 'IDM-2', 'P-62', null, 'idm-m')).error, 'idempotency_key_reused');
});
