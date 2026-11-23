// What GET /v1/occupancy returns next to GET /v1/map, and the reference check a reading system should apply.
// Throwaway local database, synthetic pallets: `node --test neutral/test/occupancy-contract.test.mjs`.
import test from 'node:test'; import assert from 'node:assert/strict'; import pg from 'pg'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { serve } from '../service/server.mjs'; import { checkOccupancy } from '../client/occupancy-check.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)); const base = 'postgres://postgres@127.0.0.1:54318';
const admin = new pg.Client(`${base}/postgres`); await admin.connect(); await admin.query('drop database if exists nexusoccupancy'); await admin.query('create database nexusoccupancy'); await admin.end();
const db = new pg.Pool({ connectionString: `${base}/nexusoccupancy` });
for (const f of ['001_core.sql', '002_floor_map.sql', '003_calendar.sql']) await db.query(fs.readFileSync(path.join(here, '..', f), 'utf8'));   // exactly what the staging service runs on
const one = async (sql, p) => Object.values((await db.query(sql, p)).rows[0])[0];
const co = (code) => one(`insert into nexus.companies (code, name) values ($1, $1) returning id`, [code]); const SOULED = await co('SOULED'), SHIPBAY = await co('SHIPBAY');
const key = (c, s) => one(`select nexus.integration_create('test', $1, $2, 'HILLSBOROUGH-TEST', '{read,move}')`, [c, s]); const kSouled = await key(SOULED, 'souled'), kShipbay = await key(SHIPBAY, 'shipbay');
const svc = await serve(`${base}/nexusoccupancy`); test.after(async () => { await svc.close(); await db.end(); });
let n = 0; const call = async (k, method, p, body) => (await fetch(svc.url + p, { method, headers: { authorization: `Bearer ${k}`, ...(body ? { 'content-type': 'application/json', 'idempotency-key': `oc-${++n}` } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
const both = async (k) => [await call(k, 'GET', '/v1/map'), await call(k, 'GET', '/v1/occupancy')];
const EXPECTED = [...Array.from({ length: 66 }, (_, i) => `P-${String(i + 1).padStart(2, '0')}`), 'STG-01', 'STG-02'];
await call(kShipbay, 'POST', '/v1/pallets/assign', { pallet: 'PSKU-000001', to: 'P-01' });   // the floor as it stands on staging: one ShipBay pallet at P-01

test('the answer as it is today: 69 locations = the 68 map destinations + RCV-DOCK, and the same 69 codes the map lists', async () => {
  const [map, occ] = await both(kSouled); const codes = occ.locations.map((l) => l.code).sort();
  assert.equal(codes.length, 69); assert.deepEqual(codes.filter((c) => !EXPECTED.includes(c)), ['RCV-DOCK'], 'exactly one code beyond the 68'); assert.deepEqual(EXPECTED.filter((c) => !codes.includes(c)), [], 'none of the 68 is missing');
  assert.deepEqual(codes, map.positions.map((p) => p.code).sort(), 'occupancy and map list the same locations');
  assert.deepEqual(map.positions.filter((p) => p.x == null || p.y == null).map((p) => [p.code, p.kind, p.block]), [['RCV-DOCK', 'dock', 'dock']], 'the map itself marks it: kind dock, no square');
  assert.deepEqual(occ.locations.find((l) => l.code === 'RCV-DOCK'), { code: 'RCV-DOCK', kind: 'dock', zone: 'receiving', status: 'open', capacity: null, used: 0, free: null, occupants: [], your_pallets: [], updated_at: occ.locations.find((l) => l.code === 'RCV-DOCK').updated_at });
  assert.deepEqual(occ.locations.filter((l) => l.capacity === null).map((l) => l.code).sort(), ['RCV-DOCK', 'STG-01', 'STG-02'], 'capacity and free are null where no limit is set');
  assert.deepEqual(Object.keys(occ.locations[0]).sort(), ['capacity', 'code', 'free', 'kind', 'occupants', 'status', 'updated_at', 'used', 'your_pallets', 'zone']);
  // what Souled is shown for P-01: the company and a count, no pallet id
  const p01 = occ.locations.find((l) => l.code === 'P-01'); assert.deepEqual([p01.used, p01.free, p01.occupants, p01.your_pallets], [1, 0, [{ company: 'SHIPBAY', pallets: 1 }], []]); assert.ok(!JSON.stringify(occ).includes('PSKU-000001'));
});
test('the reference check accepts today\'s answer and explains the dock instead of dropping it', async () => {
  const r = checkOccupancy(...(await both(kSouled))); assert.deepEqual(r, { ok: true, destinations: 68, registry_only: ['RCV-DOCK'], occupied: ['P-01'], errors: [] });
});
test('a hard-coded list of 68 is what fails: the same answer checked that way reports the dock as unknown', async () => {
  const [map, occ] = await both(kSouled); const only68 = { ...map, positions: map.positions.filter((p) => p.x != null) };
  assert.deepEqual(checkOccupancy(only68, occ).errors.map((e) => [e.code, e.location]), [['occupancy_unknown_location', 'RCV-DOCK']]);
});
test('genuinely wrong answers are never ignored', async () => {
  const [map, occ] = await both(kSouled); const edit = (f) => { const o = structuredClone(occ); f(o.locations, o); return checkOccupancy(map, o).errors.map((e) => `${e.code}:${e.location}`); };
  assert.deepEqual(edit((l) => l.push({ ...l[0], code: 'P-67', used: 0 })), ['occupancy_unknown_location:P-67'], 'a code the map does not list, even empty');
  assert.deepEqual(edit((l) => l.push({ ...l[0], code: 'OLD-A-01', used: 2 })), ['occupancy_unknown_location:OLD-A-01'], 'a legacy code holding pallets');
  assert.deepEqual(edit((l) => { l.find((x) => x.code === 'RCV-DOCK').used = 1; }), ['occupancy_off_map_occupied:RCV-DOCK'], 'a pallet standing on a location that is not a destination');
  assert.deepEqual(edit((l) => l.splice(l.findIndex((x) => x.code === 'P-40'), 1)), ['occupancy_missing_destination:P-40']);
  assert.deepEqual(edit((l) => l.splice(l.findIndex((x) => x.code === 'RCV-DOCK'), 1)), ['occupancy_missing_location:RCV-DOCK']);
  assert.deepEqual(edit((l) => { l.find((x) => x.code === 'P-02').code = 'p-02'; }), ['occupancy_bad_code:p-02', 'occupancy_missing_destination:P-02']);
  assert.deepEqual(edit((l) => l.push({ ...l.find((x) => x.code === 'P-03') })), ['occupancy_duplicate_location:P-03']);
  assert.deepEqual(edit((l) => { l.find((x) => x.code === 'P-05').used = 2; }), ['occupancy_over_capacity:P-05']);
  assert.deepEqual(edit((l) => { l.find((x) => x.code === 'STG-01').kind = 'pallet'; }), ['occupancy_kind_mismatch:STG-01']);
  assert.deepEqual(edit((l, o) => { o.warehouse = 'HILLSBOROUGH'; }), ['floor_mismatch:null']);
  assert.equal(checkOccupancy(map, { ok: false, error: 'unauthorized' }).errors[0].code, 'bad_occupancy');
});
test('finding: Nexus will today accept a pallet AT the dock, with no limit; a reading system then sees it and must not ignore it', async () => {
  const a = await call(kSouled, 'POST', '/v1/pallets/assign', { pallet: 'SYN-DOCK-1', to: 'RCV-DOCK' }); assert.equal(a.ok, true, 'accepted: the dock is an open location with no capacity limit');
  assert.equal((await call(kSouled, 'POST', '/v1/pallets/assign', { pallet: 'SYN-DOCK-2', to: 'RCV-DOCK' })).ok, true, 'and a second one');
  const seenByShipbay = checkOccupancy(...(await both(kShipbay))); assert.deepEqual(seenByShipbay.errors.map((e) => [e.code, e.location]), [['occupancy_off_map_occupied', 'RCV-DOCK']]);
  assert.match(seenByShipbay.errors[0].message, /2 pallet\(s\) stand at RCV-DOCK/);
  for (const p of ['SYN-DOCK-1', 'SYN-DOCK-2']) await call(kSouled, 'POST', '/v1/pallets/release', { pallet: p });
  assert.equal(checkOccupancy(...(await both(kShipbay))).ok, true);
});
