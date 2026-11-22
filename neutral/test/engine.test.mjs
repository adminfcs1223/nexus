// The neutral Nexus foundation on a throwaway local database (127.0.0.1 only): `node --test neutral/test/engine.test.mjs`.
// Covers the brief's occupancy cases: 1-8, 15-17 (through the functions the HTTP layer will map onto) and 18.
import test from 'node:test'; import assert from 'node:assert/strict'; import pg from 'pg'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)); const base = 'postgres://postgres@127.0.0.1:54318';
const admin = new pg.Client(`${base}/postgres`); await admin.connect(); await admin.query('drop database if exists nexusneutral'); await admin.query('create database nexusneutral'); await admin.end();
const pool = new pg.Pool({ connectionString: `${base}/nexusneutral`, max: 30 });
for (const f of ['001_core.sql', '002_v1_map.sql']) await pool.query(fs.readFileSync(path.join(here, '..', f), 'utf8'));
const q = async (sql, p) => (await pool.query(sql, p)).rows; const one = async (sql, p) => Object.values((await q(sql, p))[0])[0];
const co = async (code, name) => one(`insert into nexus.companies (code, name) values ($1, $2) returning id`, [code, name]);
const SOULED = await co('SOULED', 'Souled Worldwide'), SHIPBAY = await co('SHIPBAY', 'ShipBay3PL');
const key = (c, sys, scopes) => one(`select nexus.integration_create('test', $1, $2, $3)`, [c, sys, scopes]);
const kSouled = await key(SOULED, 'souled-wms', ['read', 'move']), kShipbay = await key(SHIPBAY, 'shipbay-wms', ['read', 'move']), kReadOnly = await key(SHIPBAY, 'shipbay-dashboard', ['read']);
let n = 0; const place = (k, kind, pallet, to, from = null, idem = `t-${++n}`) => one(`select nexus.api_place($1, $2, $3, $4, $5, $6)`, [k, kind, pallet, to, from, idem]);
const occ = async (k, code) => (await one(`select nexus.api_occupancy($1)`, [k])).locations.find((l) => l.code === code);
test.after(() => pool.end());

test('the v1 map is the registry: 72 positions drawn, 64 open; 2 staging, 1 open; 1 dock', async () => {
  const r = (await q(`select kind, status, count(*)::int n from nexus.locations group by 1, 2 order by 1, 2`)).map((x) => `${x.kind}/${x.status}/${x.n}`);
  assert.deepEqual(r, ['dock/open/1', 'pallet/open/64', 'pallet/unavailable/8', 'staging/open/1', 'staging/unavailable/1']);
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
  const where = async () => one(`select l.code from nexus.occupancy o join nexus.locations l on l.id = o.location_id join nexus.pallets p on p.id = o.pallet_id where p.external_id = 'SW-0001' and p.company_id = $1`, [SOULED]);
  const before = await where();
  assert.equal((await place(kSouled, 'move', 'SW-0001', 'P-65')).error, 'location_unavailable'); assert.equal((await place(kSouled, 'move', 'SW-0001', 'NOPE-1')).error, 'location_not_found');
  assert.equal((await place(kSouled, 'move', 'SW-0001', 'P-20', 'P-64')).error, 'pallet_elsewhere', 'stale: the caller thought it was somewhere else');
  assert.equal(await where(), before);
});
test('capacity and blocking: staging is not limited; a blocked location refuses; capacity never drops below what stands there', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await place(kShipbay, 'assign', `STG-${i}`, 'STG-01')).ok, true);
  assert.deepEqual((await occ(kSouled, 'STG-01')).occupants, [{ company: 'SHIPBAY', pallets: 5 }]);
  assert.equal((await one(`select nexus.location_set('admin:test', 'STG-01', null, null, 3)`)).error, 'capacity_below_occupancy');
  await one(`select nexus.location_set('admin:test', 'P-30', 'blocked', 'Leak from the roof', null)`);
  const r = await place(kSouled, 'assign', 'SW-0100', 'P-30'); assert.deepEqual([r.error, r.message], ['location_blocked', 'Leak from the roof']);
  await one(`select nexus.location_set('admin:test', 'P-30', 'open', null, 2)`); assert.equal((await place(kSouled, 'assign', 'SW-0100', 'P-30', null, 'retry-new-key')).free, 1);
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
