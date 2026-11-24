// Forward-only launch on a throwaway local database (the staging stack plus 010): `node --test neutral/test/forward-only.test.mjs`
import test from 'node:test'; import assert from 'node:assert/strict'; import pg from 'pg'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { serve } from '../service/server.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)); const base = 'postgres://postgres@127.0.0.1:54318'; const DBN = 'nexusforward'; const REAL = 'HILLSBOROUGH', TEST = 'HILLSBOROUGH-TEST';
const boot = new pg.Client(`${base}/postgres`); await boot.connect(); await boot.query(`drop database if exists ${DBN}`); await boot.query(`create database ${DBN}`); await boot.end();
const db = new pg.Pool({ connectionString: `${base}/${DBN}` });
for (const f of ['001_core.sql', '002_floor_map.sql', '003_calendar.sql', '004_baseline.sql', '005_key_handoff.sql', '007_destinations_only.sql']) await db.query(fs.readFileSync(path.join(here, '..', f), 'utf8'));
const one = async (sql, p) => Object.values((await db.query(sql, p)).rows[0])[0]; const rows = async (sql, p) => (await db.query(sql, p)).rows;
const SOULED = await one(`insert into nexus.companies (code, name) values ('SOULED', 'Souled Worldwide') returning id`), SHIPBAY = await one(`insert into nexus.companies (code, name) values ('SHIPBAY', 'ShipBay3PL') returning id`);
const key = (c, sys, wh, scopes) => one(`select nexus.integration_create('test', $1, $2, $3, $4)`, [c, sys, wh, scopes]);
const k = { souled: await key(SOULED, 's-prod', REAL, ['read', 'move']), shipbay: await key(SHIPBAY, 'b-prod', REAL, ['read', 'move']), sRead: await key(SOULED, 's-read', REAL, ['read']), sTest: await key(SOULED, 's-test', TEST, ['read', 'move']) };
// a pallet already on the test floor before the change, as on staging
const svc0 = await serve(`${base}/${DBN}`); let n = 0;
const mk = (svc) => (kk) => async (method, p, body, idem) => { const r = await fetch(svc.url + p, { method, headers: { authorization: `Bearer ${kk}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(method === 'POST' ? { 'idempotency-key': idem || `fo-${++n}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { ...(await r.json()), status: r.status }; };
assert.equal((await mk(svc0)(k.sTest)('POST', '/v1/pallets/assign', { pallet: 'OLD-1', to: 'P-02' }, 'old-key-1')).ok, true); await svc0.close();
await db.query(fs.readFileSync(path.join(here, '..', '010_forward_only.sql'), 'utf8'));
const svc = await serve(`${base}/${DBN}`); const sys = mk(svc); const souled = sys(k.souled), shipbay = sys(k.shipbay), sRead = sys(k.sRead), sTest = sys(k.sTest);
test.after(async () => { await svc.close(); await db.end(); });
const OK = { confirmed_empty: true, confirmed_by: 'J. Rivera' }; const at = async (s, code) => (await s('GET', '/v1/occupancy')).locations.find((l) => l.code === code);

test('before opening: the real floor is locked exactly as before; the test floor and its old keys are unaffected by the change', async () => {
  assert.equal((await souled('POST', '/v1/pallets/assign', { pallet: 'R-1', to: 'P-01', ...OK })).status, 423);
  assert.deepEqual((({ ok, replayed }) => [ok, replayed])(await sTest('POST', '/v1/pallets/assign', { pallet: 'OLD-1', to: 'P-02' }, 'old-key-1')), [true, true], 'a key recorded before the change still replays');
  assert.equal((await sTest('POST', '/v1/pallets/move', { pallet: 'OLD-1', to: 'P-03', from: 'P-02' })).ok, true, 'no confirmation is asked on a test floor');
});
test('opening: only a blank, uninitialized real floor, with the owner decision on record', async () => {
  assert.equal((await one(`select nexus.floor_open_forward_only('t', $1, 'owner decision 2026-11-24 greenfield')`, [TEST])).error, 'bad_request');
  assert.equal((await one(`select nexus.floor_open_forward_only('t', $1, 'x')`, [REAL])).error, 'bad_request');
  const o = await one(`select nexus.floor_open_forward_only('t', $1, 'owner decision 2026-11-24 greenfield')`, [REAL]); assert.deepEqual([o.ok, o.occupancy_state, o.moves_enabled], [true, 'forward_only', true]);
  assert.equal((await one(`select nexus.floor_open_forward_only('t', $1, 'owner decision 2026-11-24 greenfield')`, [REAL])).error, 'floor_not_ready');
  const m = await souled('GET', '/v1/map'); assert.deepEqual([m.warehouse, m.occupancy_state, m.moves_enabled, m.map_version, m.checksum], [REAL, 'forward_only', true, 4, 'be3cc8f3e9134cb4dfe7d3ac41773bc5d231ed56b4a42c05f5939467d67c8c4f']);
  assert.equal((await souled('GET', '/v1/occupancy')).locations.reduce((t, l) => t + l.used, 0), 0, 'zero recorded pallets');
  assert.deepEqual((await rows(`select action, after ->> 'authority' a from nexus.audit_log where action = 'forward_only_opened'`)), [{ action: 'forward_only_opened', a: 'owner decision 2026-11-24 greenfield' }]);
  assert.ok((await shipbay('GET', '/v1/changes?after=0')).changes.some((c) => c.kind === 'movements_enabled'));
});
test('no confirmation, no placement: refused, nothing recorded, and the same key works once the confirmation is sent', async () => {
  const before = await one(`select count(*)::int from nexus.moves`);
  for (const extra of [{}, { confirmed_empty: false, confirmed_by: 'J. Rivera' }, { confirmed_empty: 'true', confirmed_by: 'J. Rivera' }, { confirmed_empty: true }, { confirmed_empty: true, confirmed_by: ' ' }, { confirmed_empty: true, confirmed_by: 'x' }, { confirmed_by: 'J. Rivera' }]) {
    const r = await souled('POST', '/v1/pallets/assign', { pallet: 'R-1', to: 'P-01', ...extra }, 'recv-1'); assert.deepEqual([r.status, r.error], [400, 'location_not_confirmed'], JSON.stringify(extra));
  }
  assert.deepEqual([await one(`select count(*)::int from nexus.moves`), (await at(souled, 'P-01')).used], [before, 0]);
  assert.equal((await one(`select nexus.place('x', $1, $2, 's', 'assign', 'R-1', 'P-01', null, 'direct-1')`, [REAL, SOULED])).error, 'location_not_confirmed', 'also when the engine is called directly');
  const ok = await souled('POST', '/v1/pallets/assign', { pallet: 'R-1', to: 'P-01', ...OK }, 'recv-1'); assert.deepEqual([ok.status, ok.ok, ok.location, ok.free], [200, true, 'P-01', 0]);
  const rec = (await rows(`select confirmation from nexus.moves where idempotency_key = 'recv-1'`))[0].confirmation; assert.deepEqual([rec.empty, rec.by, rec.location, typeof rec.at], [true, 'J. Rivera', 'P-01', 'string']);
  assert.equal((await souled('POST', '/v1/pallets/assign', { pallet: 'R-1', to: 'P-01', ...OK }, 'recv-1')).replayed, true);
});
test('everything else still holds on the live floor: conflicts, ownership, the dock, stale moves, privacy, read-only keys; a move needs a confirmation, a release does not', async () => {
  const clash = await shipbay('POST', '/v1/pallets/assign', { pallet: 'B-1', to: 'P-01', ...OK }); assert.deepEqual([clash.status, clash.error], [409, 'location_full'], 'a confirmation never overrides what Nexus has recorded');
  assert.equal((await shipbay('POST', '/v1/pallets/assign', { pallet: 'B-1', to: 'RCV-DOCK', ...OK })).error, 'location_not_a_destination'); assert.equal((await shipbay('POST', '/v1/pallets/move', { pallet: 'R-1', to: 'P-05', from: 'P-01', ...OK })).status, 404);
  assert.equal((await sRead('POST', '/v1/pallets/assign', { pallet: 'R-9', to: 'P-09', ...OK })).status, 403);
  assert.equal((await shipbay('POST', '/v1/pallets/assign', { pallet: 'B-1', to: 'P-31', confirmed_empty: true, confirmed_by: 'T. Okafor' })).ok, true);
  assert.equal((await souled('POST', '/v1/pallets/move', { pallet: 'R-1', to: 'P-02', from: 'P-01' })).error, 'location_not_confirmed'); assert.equal((await souled('POST', '/v1/pallets/move', { pallet: 'R-1', to: 'P-02', from: 'P-09', ...OK })).error, 'pallet_elsewhere');
  const mv = await souled('POST', '/v1/pallets/move', { pallet: 'R-1', to: 'P-02', from: 'P-01', ...OK }); assert.deepEqual([mv.ok, mv.from, mv.location], [true, 'P-01', 'P-02']);
  const seenByShipbay = await at(shipbay, 'P-02'), seenBySouled = await at(souled, 'P-31'); assert.deepEqual([seenByShipbay.occupants, seenByShipbay.your_pallets, seenBySouled.occupants, seenBySouled.your_pallets], [[{ company: 'SOULED', pallets: 1 }], [], [{ company: 'SHIPBAY', pallets: 1 }], []]);
  assert.ok(!JSON.stringify([await shipbay('GET', '/v1/occupancy'), await shipbay('GET', '/v1/changes?after=0')]).match(/R-1|J\. Rivera/) && !JSON.stringify(await shipbay('GET', '/v1/moves')).includes('J. Rivera'), 'neither the other company\'s pallet id nor who confirmed it is shown');
  assert.equal((await souled('POST', '/v1/pallets/release', { pallet: 'R-1', from: 'P-02' })).ok, true);
  const race = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? souled : shipbay)('POST', '/v1/pallets/assign', { pallet: `RACE-${i}`, to: 'P-40', ...OK }))); assert.deepEqual([race.filter((r) => r.ok).length, race.filter((r) => r.error === 'location_full').length], [1, 11]);
});
test('stopping and rolling back: switching the floor off refuses everything again and keeps what was recorded', async () => {
  await db.query(`update nexus.warehouses set moves_enabled = false where code = $1`, [REAL]);
  assert.equal((await shipbay('POST', '/v1/pallets/assign', { pallet: 'B-2', to: 'P-32', ...OK })).status, 423); assert.equal((await at(souled, 'P-31')).used, 1);
  await assert.rejects(db.query(`update nexus.warehouses set occupancy_state = 'not_initialized', moves_enabled = true where code = $1`, [REAL]), /warehouses_check1/, 'an uninitialized real floor still cannot be switched on');
});
