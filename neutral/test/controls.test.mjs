// Baseline controls on a throwaway local database (127.0.0.1 only), synthetic pallets: `node --test neutral/test/controls.test.mjs`.
// The floor called HILLSBOROUGH here is a copy inside that throwaway database. No hosted system is touched.
import test from 'node:test'; import assert from 'node:assert/strict'; import pg from 'pg'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { validate, fingerprintOf, POSITIONS } from '../baseline/validate.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)); const base = 'postgres://postgres@127.0.0.1:54318';
const admin = new pg.Client(`${base}/postgres`); await admin.connect(); await admin.query('drop database if exists nexuscontrols'); await admin.query('create database nexuscontrols'); await admin.end();
const pool = new pg.Pool({ connectionString: `${base}/nexuscontrols` });
for (const f of ['001_core.sql', '002_floor_map.sql', '003_calendar.sql', '004_baseline.sql']) await pool.query(fs.readFileSync(path.join(here, '..', f), 'utf8'));
const q = async (sql, p) => (await pool.query(sql, p)).rows; const one = async (sql, p) => Object.values((await q(sql, p))[0])[0];
test.after(() => pool.end());
const WH = 'HILLSBOROUGH'; const T = '2026-12-05T09:00:00-05:00';
await q(`insert into nexus.companies (code, name) values ('SOULED', 'Souled Worldwide'), ('SHIPBAY', 'ShipBay3PL')`);
const op = (company, name, roles) => one(`select nexus.operator_create('test', $1, $2, $3)`, [company, name, roles]);
const owner = await op(null, 'Owner', ['initialize', 'unlock', 'stop', 'registry', 'view']), souledRep = await op('SOULED', 'Souled Approver', ['approve_baseline', 'stop']), souledRep2 = await op('SOULED', 'Souled Second', ['approve_baseline']),
  shipbayRep = await op('SHIPBAY', 'ShipBay Approver', ['approve_baseline', 'stop']), viewer = await op(null, 'Viewer', ['view']);
const call = (fn, ...args) => one(`select nexus.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')})`, args);
const SOULED = await one(`select id from nexus.companies where code = 'SOULED'`), SHIPBAY = await one(`select id from nexus.companies where code = 'SHIPBAY'`);
const kLive = await one(`select nexus.integration_create('test', $1, 'souled-wms', $2, '{read,move}')`, [SOULED, WH]), kTest = await one(`select nexus.integration_create('test', $1, 'shipbay-dev', 'HILLSBOROUGH-TEST', '{read,move}')`, [SHIPBAY]);
const place = (k, kind, pallet, to, idem) => one(`select nexus.api_place($1, $2, $3, $4, null, $5)`, [k, kind, pallet, to, idem]);
// the test floor keeps one synthetic pallet throughout, like staging does
assert.equal((await place(kTest, 'assign', 'PSKU-000001', 'P-01', 'seed')).ok, true);
const checksum = () => one(`select nexus._map_checksum($1)`, [WH]); const version = () => one(`select map_version from nexus.warehouses where code = $1`, [WH]);
const FLOOR = { 'P-01': [['SOULED', 'SW-1001']], 'P-02': [['SOULED', 'SW-1002']], 'P-31': [['SHIPBAY', 'PSKU-000101']], 'STG-01': [['SHIPBAY', 'PSKU-000102']] };
const sheet = (who, floor = FLOOR) => POSITIONS.flatMap((p) => (floor[p.code] ? floor[p.code].map(([company, pallet_id]) => ({ position: p.code, state: 'OCCUPIED', company, pallet_id, counted_by: who, counted_at: T })) : [{ position: p.code, state: 'EMPTY', company: '', pallet_id: '', counted_by: who, counted_at: T }]));
const reportFor = async (floor = FLOOR, extra = {}) => validate({ count: sheet('Counter A', floor), second: sheet('Counter B', floor), mapVersion: await version(), mapChecksum: await checksum(), ...extra });
const occ = async (wh = WH) => (await q(`select c.code || ' ' || p.external_id || ' @ ' || l.code x from nexus.occupancy o join nexus.pallets p on p.id = o.pallet_id join nexus.companies c on c.id = p.company_id join nexus.locations l on l.id = o.location_id where l.warehouse = $1 order by l.code, 1`, [wh])).map((r) => r.x);
const state = async () => (await q(`select occupancy_state s, moves_enabled m from nexus.warehouses where code = $1`, [WH])).map((r) => `${r.s}/${r.m}`)[0];
let baseline, report;

test('the map checksum used for baselines is the one the API publishes', async () => {
  assert.equal(await checksum(), (await one(`select nexus.api_map($1)`, [kLive])).checksum);
});
test('submit: only a passed, untouched validator report whose contents Nexus itself accepts', async () => {
  report = await reportFor(); assert.equal(report.ready_for_joint_approval, true);
  assert.equal((await call('baseline_submit', viewer, WH, report)).error, 'forbidden'); assert.equal((await call('baseline_submit', 'nxo_wrong', WH, report)).error, 'unauthorized');
  assert.equal((await call('baseline_submit', owner, 'HILLSBOROUGH-TEST', report)).error, 'test_floor');
  const failed = validate({ count: sheet('Counter A'), mapVersion: await version(), mapChecksum: await checksum() }); assert.equal((await call('baseline_submit', owner, WH, failed)).error, 'not_a_passed_report');
  const edited = structuredClone(report); edited.baseline.find((e) => e.position === 'P-02').pallets[0].pallet = 'SW-9999';
  assert.equal((await call('baseline_submit', owner, WH, edited)).error, 'fingerprint_mismatch', 'edited after validation');
  assert.equal((await call('baseline_submit', owner, WH, await reportFor(FLOOR, { mapChecksum: 'f'.repeat(64) }))).error, 'map_mismatch');
  assert.equal((await call('baseline_submit', owner, WH, { ...report, counters: { count_1: ['Counter A'], count_2: ['counter a'] } })).error, 'counts_not_independent');
  // reports forged with a correct fingerprint are still caught by Nexus's own rules
  const forge = async (floorEdit) => { const r = structuredClone(report); floorEdit(r.baseline); r.baseline_fingerprint = fingerprintOf(r.baseline, await version(), await checksum()); return call('baseline_submit', owner, WH, r); };
  const codes = (r) => (r.problems || [{ code: JSON.stringify(r) }]).map((p) => p.code).sort();
  assert.deepEqual(codes(await forge((b) => b.find((e) => e.position === 'STG-01').pallets.push({ company: 'SHIPBAY', pallet: 'PSKU-000199' }))), ['over_capacity'], 'staging holds one until its capacity is verified');
  assert.deepEqual(codes(await forge((b) => { b.find((e) => e.position === 'P-40').pallets.push({ company: 'SHIPBAY', pallet: 'psku-000001' }); })), ['test_pallet_id'], 'the test floor\'s pallet can never become real');
  assert.deepEqual(codes(await forge((b) => { b.find((e) => e.position === 'P-41').pallets.push({ company: 'ACME', pallet: 'A-1' }); b.find((e) => e.position === 'P-42').pallets.push({ company: 'SOULED', pallet: 'sw-1001' }); b.pop(); b.push({ position: 'P-67', pallets: [] }); })),
    ['duplicate_pallet', 'missing_position', 'unknown_owner', 'unknown_position']);
  assert.equal(await one(`select count(*)::int from nexus.baselines`), 0, 'nothing refused was stored');
  const ok = await call('baseline_submit', owner, WH, report); assert.deepEqual([ok.ok, ok.fingerprint, ok.status, ok.needs_approval_from], [true, report.baseline_fingerprint, 'submitted', ['SHIPBAY', 'SOULED']]); baseline = ok.baseline;
});
test('approve: each company separately, the same fingerprint, never the submitter; no initialization before both', async () => {
  await assert.rejects(op(null, 'No company', ['approve_baseline']), /check/, 'an approver always belongs to a company');
  assert.equal((await call('baseline_approve', owner, baseline, report.baseline_fingerprint)).error, 'forbidden');
  assert.equal((await call('baseline_approve', souledRep, baseline, 'a'.repeat(64))).error, 'fingerprint_mismatch');
  const a1 = await call('baseline_approve', souledRep, baseline, report.baseline_fingerprint); assert.deepEqual([a1.status, a1.still_needed_from], ['submitted', ['SHIPBAY']]);
  assert.equal((await call('baseline_approve', souledRep2, baseline, report.baseline_fingerprint)).error, 'already_approved', 'a second Souled approval does not stand in for ShipBay');
  assert.equal((await call('baseline_initialize', owner, baseline, report.baseline_fingerprint, 'backup-rehearsal-1')).error, 'not_approved'); assert.deepEqual(await occ(), []);
  const a2 = await call('baseline_approve', shipbayRep, baseline, report.baseline_fingerprint); assert.deepEqual([a2.status, a2.still_needed_from], ['approved', []]);
  const bySubmitter = await call('baseline_submit', souledRep, WH, report); assert.equal((await call('baseline_approve', souledRep, bySubmitter.baseline, report.baseline_fingerprint)).error, 'not_independent');
  assert.equal(await one(`select status from nexus.baselines where id = $1`, [baseline]), 'superseded', 'a newer submission voids the earlier approvals');
  await call('baseline_reject', shipbayRep, bySubmitter.baseline, 'submitted only to test independence');
  baseline = (await call('baseline_submit', owner, WH, report)).baseline; await call('baseline_approve', souledRep, baseline, report.baseline_fingerprint); await call('baseline_approve', shipbayRep, baseline, report.baseline_fingerprint);
});
test('initialize: its own role, a named backup, all or nothing; an interrupted run leaves the floor untouched and can be repeated', async () => {
  assert.equal((await call('baseline_initialize', souledRep, baseline, report.baseline_fingerprint, 'backup-1')).error, 'forbidden');
  assert.equal((await call('baseline_initialize', owner, baseline, 'b'.repeat(64), 'backup-1')).error, 'fingerprint_mismatch'); assert.equal((await call('baseline_initialize', owner, baseline, report.baseline_fingerprint, '')).error, 'backup_required');
  const d = await call('discrepancy_open', souledRep, WH, 'P-02', 'label', 'Pallet label at P-02 is torn'); assert.equal((await call('baseline_initialize', owner, baseline, report.baseline_fingerprint, 'backup-1')).error, 'open_discrepancies');
  await call('discrepancy_resolve', shipbayRep, d.discrepancy, 'Relabeled and checked by both floor leads');
  // interruption: the database fails on the third pallet
  await q(`create function nexus._fail_third() returns trigger language plpgsql as $f$ begin if (select count(*) from nexus.occupancy o join nexus.locations l on l.id = o.location_id where l.warehouse = 'HILLSBOROUGH') >= 2 then raise exception 'simulated interruption'; end if; return new; end $f$`);
  await q(`create trigger fail_third before insert on nexus.occupancy for each row execute function nexus._fail_third()`);
  await assert.rejects(call('baseline_initialize', owner, baseline, report.baseline_fingerprint, 'backup-1'), /simulated interruption/);
  assert.deepEqual([await occ(), await state(), await one(`select status from nexus.baselines where id = $1`, [baseline]), await one(`select count(*)::int from nexus.pallets where warehouse = $1`, [WH])], [[], 'not_initialized/false', 'approved', 0], 'nothing half-written');
  await q(`drop trigger fail_third on nexus.occupancy; drop function nexus._fail_third()`);
  const r = await call('baseline_initialize', owner, baseline, report.baseline_fingerprint, 'backup-1'); assert.deepEqual([r.ok, r.pallets, r.occupancy_state, r.moves_enabled], [true, 4, 'verified', false]);
  assert.deepEqual(await occ(), ['SOULED SW-1001 @ P-01', 'SOULED SW-1002 @ P-02', 'SHIPBAY PSKU-000101 @ P-31', 'SHIPBAY PSKU-000102 @ STG-01']); assert.equal(await state(), 'verified/false', 'initialized, still locked');
  assert.equal((await place(kLive, 'move', 'SW-1001', 'P-03', 'm-locked')).error, 'occupancy_not_initialized', 'movements are still off'); assert.equal((await call('baseline_initialize', owner, baseline, report.baseline_fingerprint, 'backup-1')).error, 'not_approved', 'it cannot be applied twice');
  assert.deepEqual((await one(`select nexus.api_occupancy($1)`, [kLive])).locations.find((l) => l.code === 'P-31').occupants, [{ company: 'SHIPBAY', pallets: 1 }]);
});
test('an unused initialization can be taken back and done again', async () => {
  assert.equal((await call('baseline_revert', owner, baseline, 'Wrong sheet was approved')).ok, true); assert.deepEqual([await occ(), await state()], [[], 'not_initialized/false']);
  baseline = (await call('baseline_submit', owner, WH, report)).baseline; await call('baseline_approve', souledRep, baseline, report.baseline_fingerprint); await call('baseline_approve', shipbayRep, baseline, report.baseline_fingerprint);
  assert.equal((await call('baseline_initialize', owner, baseline, report.baseline_fingerprint, 'backup-2')).ok, true);
});
test('unlock is a separate step: confirmation, verified capacities, and a fresh go from each company', async () => {
  assert.equal((await call('floor_unlock', souledRep, WH, `UNLOCK ${WH}`)).error, 'forbidden'); assert.equal((await call('floor_unlock', owner, WH, 'yes')).error, 'confirmation_required');
  const cap = await call('floor_unlock', owner, WH, `UNLOCK ${WH}`); assert.deepEqual([cap.error, cap.positions], ['capacity_not_verified', 68]);
  await assert.rejects(pool.query(`update nexus.warehouses set moves_enabled = true where code = 'HILLSBOROUGH' and occupancy_state <> 'verified'`).then((r) => { if (!r.rowCount) throw new Error('no row: the floor is verified'); }), /no row/);
  assert.equal((await call('location_capacity_verify', souledRep, WH, 'P-01', 1, 'site walk')).error, 'forbidden');
  for (const p of POSITIONS) assert.equal((await call('location_capacity_verify', owner, WH, p.code, 1, 'Owner sketch 2026-11-22 and site walk')).ok, true);
  assert.equal(await version(), 6, 'setting the two staging spots to a verified capacity of one changed the map twice');
  assert.deepEqual((await call('floor_unlock', owner, WH, `UNLOCK ${WH}`)).still_needed_from, ['SHIPBAY', 'SOULED']);
  await call('floor_unlock_approve', souledRep, WH); assert.deepEqual((await call('floor_unlock', owner, WH, `UNLOCK ${WH}`)).still_needed_from, ['SHIPBAY']);
  await call('floor_unlock_approve', shipbayRep, WH);
  const d = await call('discrepancy_open', shipbayRep, WH, 'P-31', 'count', 'Recheck requested'); assert.equal((await call('floor_unlock', owner, WH, `UNLOCK ${WH}`)).error, 'open_discrepancies'); await call('discrepancy_resolve', souledRep, d.discrepancy, 'Rechecked, matches');
  const u = await call('floor_unlock', owner, WH, `UNLOCK ${WH}`); assert.deepEqual([u.ok, u.moves_enabled, u.changed], [true, true, true]); assert.equal(await state(), 'verified/true');
  assert.deepEqual([(await place(kLive, 'move', 'SW-1001', 'P-03', 'm-1')).ok, (await place(kLive, 'move', 'SW-1002', 'P-31', 'm-2')).error, (await place(kLive, 'assign', 'SW-1003', 'STG-01', 'm-3')).error], [true, 'location_full', 'location_full'], 'baseline pallets move like any other; staging holds one');
  assert.equal((await call('baseline_revert', owner, baseline, 'too late')).error, 'floor_in_use');
});
test('stop: immediate, no approvals; unlocking again needs a new go from both', async () => {
  assert.equal((await call('floor_stop', viewer, WH, 'x')).error, 'forbidden');
  const s = await call('floor_stop', souledRep, WH, 'Pallet seen at P-04 that Nexus does not show'); assert.deepEqual([s.ok, s.moves_enabled, s.changed], [true, false, true]);
  assert.equal((await place(kLive, 'move', 'SW-1001', 'P-05', 'm-4')).error, 'occupancy_not_initialized'); assert.equal((await one(`select nexus.api_occupancy($1)`, [kLive])).ok, true, 'reads keep working');
  assert.equal((await call('floor_stop', shipbayRep, WH, 'second press')).changed, false);
  assert.deepEqual((await call('floor_unlock', owner, WH, `UNLOCK ${WH}`)).still_needed_from, ['SHIPBAY', 'SOULED'], 'approvals given before the stop no longer count');
  assert.equal((await place(kLive, 'move', 'SW-1001', 'P-05', 'm-4')).error, 'occupancy_not_initialized', 'a locked-floor answer is not kept: the same key works once the floor reopens');
  await call('floor_unlock_approve', souledRep, WH); await call('floor_unlock_approve', shipbayRep, WH); assert.equal((await call('floor_unlock', owner, WH, `UNLOCK ${WH}`)).ok, true);
  assert.equal((await place(kLive, 'move', 'SW-1001', 'P-05', 'm-4')).ok, true);
});
test('view: state, approvals, discrepancies and the audit trail in one place; the test floor was never touched', async () => {
  const st = await call('floor_status', viewer, WH);
  assert.deepEqual([st.occupancy_state, st.moves_enabled, st.occupied, st.capacity_unverified, st.open_discrepancies.length], ['verified', true, 4, 0, 0]);
  assert.deepEqual(st.baselines.map((b) => b.status).sort(), ['applied', 'rejected', 'reverted', 'superseded']); assert.deepEqual(st.baselines.find((b) => b.status === 'applied').approvals.map((x) => `${x.company}:${x.by}`), ['SHIPBAY:ShipBay Approver', 'SOULED:Souled Approver']);
  const actions = new Set(st.audit.map((x) => x.action));
  for (const a of ['baseline_submitted', 'baseline_approved', 'baseline_rejected', 'occupancy_initialized', 'occupancy_reverted', 'capacity_verified', 'unlock_approved', 'movements_enabled', 'movements_stopped', 'discrepancy_opened', 'discrepancy_resolved']) assert.ok(actions.has(a), a);
  assert.ok(st.audit.every((x) => /^op:/.test(x.actor)), 'every entry names the operator');
  assert.deepEqual(await occ('HILLSBOROUGH-TEST'), ['SHIPBAY PSKU-000001 @ P-01']);
  assert.deepEqual((await q(`select kind from nexus.change_log where warehouse = $1 and kind not like 'pallet%' and kind <> 'map_changed' order by seq`, [WH])).map((r) => r.kind), ['occupancy_initialized', 'occupancy_reverted', 'occupancy_initialized', 'movements_enabled', 'movements_stopped', 'movements_enabled']);
});
test('the snapshot digest is stable when nothing changes and moves when anything does', async () => {
  const a = await one(`select nexus.snapshot_digest()`), b = await one(`select nexus.snapshot_digest()`); assert.equal(a._all, b._all); assert.ok(a.occupancy.rows === 5 && a.baselines.rows === 4);
  await place(kLive, 'move', 'SW-1001', 'P-06', 'm-5'); const c = await one(`select nexus.snapshot_digest()`); assert.notEqual(c._all, a._all); assert.notEqual(c.occupancy.digest, a.occupancy.digest); assert.equal(c.locations.digest, a.locations.digest);
});
