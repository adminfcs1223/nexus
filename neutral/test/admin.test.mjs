// Administrator controls and permissions on a throwaway local database: `node --test neutral/test/admin.test.mjs`.
// Synthetic operators and a rehearsal floor only. The floor called HILLSBOROUGH here is a copy inside the throwaway
// database; the tests prove the controls cannot reach it. No hosted system is touched.
import test from 'node:test'; import assert from 'node:assert/strict'; import pg from 'pg'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { validate, POSITIONS } from '../baseline/validate.mjs'; import { serveAdmin } from './legacy/admin-v1-server.mjs'; import { makeAdminHandler } from './legacy/admin-v1.mjs'; import { serve } from '../service/server.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)); const host = '127.0.0.1:54318'; const DBN = 'nexusadmin';
const admin = new pg.Client(`postgres://postgres@${host}/postgres`); await admin.connect(); await admin.query(`drop database if exists ${DBN}`); await admin.query(`create database ${DBN}`);
const owner = new pg.Pool({ connectionString: `postgres://postgres@${host}/${DBN}` });
for (const f of ['001_core.sql', '002_floor_map.sql', '003_calendar.sql', '004_baseline.sql', '005_key_handoff.sql', '006_admin_controls.sql']) await owner.query(fs.readFileSync(path.join(here, '..', f), 'utf8'));
// three database logins: the integration service's, the admin service's, and one with nothing
for (const [r, g] of [['t_nexus_api', 'nexus_api'], ['t_nexus_admin', 'nexus_admin_api'], ['t_outsider', null]]) {
  await owner.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} login; end if; end $$`); if (g) await owner.query(`grant ${g} to ${r}`);
  await owner.query(`grant connect on database ${DBN} to ${r}`);
}
const as = (role) => new pg.Pool({ connectionString: `postgres://${role}@${host}/${DBN}`, max: 3 }); const pApi = as('t_nexus_api'), pAdmin = as('t_nexus_admin'), pOut = as('t_outsider');
const on = (p) => ({ q: async (sql, a) => (await p.query(sql, a)).rows, one: async (sql, a) => Object.values((await p.query(sql, a)).rows[0])[0] }); const O = on(owner);
const RF = 'REHEARSAL-01', REAL = 'HILLSBOROUGH', T = '2026-12-05T09:00:00-05:00';
await O.q(`insert into nexus.companies (code, name) values ('SOULED', 'Souled Worldwide'), ('SHIPBAY', 'ShipBay3PL')`); await O.one(`select nexus.rehearsal_floor_create($1, $2)`, [RF, REAL]);
const SOULED = await O.one(`select id from nexus.companies where code = 'SOULED'`);
const mkOp = (company, name, roles, floors = [RF], synthetic = true) => O.one(`select nexus.operator_create('test', $1, $2, $3, $4, $5)`, [company, name, roles, floors, synthetic]);
const tok = { init: await mkOp(null, 'Syn Initializer', ['initialize', 'registry', 'view']), unlock: await mkOp(null, 'Syn Unlocker', ['unlock']), souled: await mkOp('SOULED', 'Syn Souled Approver', ['approve_baseline', 'stop']),
  souled2: await mkOp('SOULED', 'Syn Souled Second', ['approve_baseline']), shipbay: await mkOp('SHIPBAY', 'Syn ShipBay Approver', ['approve_baseline', 'stop']), viewer: await mkOp(null, 'Syn Viewer', ['view']),
  realFloor: await mkOp(null, 'Local stand-in for a real-floor operator', ['initialize', 'unlock', 'stop', 'registry', 'view'], [REAL], false) };
const kMove = await O.one(`select nexus.integration_create('test', $1, 'souled-syn', $2, '{read,move}')`, [SOULED, RF]);
let svc = await serveAdmin(`postgres://t_nexus_admin@${host}/${DBN}`, { mode: 'synthetic', floors: [RF] }); const pub = await serve(`postgres://t_nexus_api@${host}/${DBN}`);
test.after(async () => { await svc.close().catch(() => {}); await pub.close(); for (const p of [pApi, pAdmin, pOut, owner]) await p.end(); await admin.end(); });
const http = async (base, token, method, p, body) => { const r = await fetch(base + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { http: r.status, ...(await r.json()) }; };
const A = (who, method, p, body) => http(svc.url, tok[who] ?? who, method, `/admin/v1/floors/${RF}${p}`, body);
const state = async (wh) => (await O.q(`select occupancy_state s, moves_enabled m from nexus.warehouses where code = $1`, [wh])).map((r) => `${r.s}/${r.m}`)[0];
const gos = () => O.one(`select count(*)::int from nexus.unlock_approvals where warehouse = $1 and voided_at is null`, [RF]);
const FLOOR = { 'P-01': ['SOULED', 'SYN-S-1'], 'P-02': ['SOULED', 'SYN-S-2'], 'P-31': ['SHIPBAY', 'SYN-B-1'] };
const sheet = (who, floor = FLOOR) => POSITIONS.map((p) => (floor[p.code] ? { position: p.code, state: 'OCCUPIED', company: floor[p.code][0], pallet_id: floor[p.code][1], counted_by: who, counted_at: T } : { position: p.code, state: 'EMPTY', counted_by: who, counted_at: T }));
const report = async (floor = FLOOR) => validate({ count: sheet('Counter A', floor), second: sheet('Counter B', floor), mapVersion: await O.one(`select map_version from nexus.warehouses where code = $1`, [RF]), mapChecksum: await O.one(`select nexus._map_checksum($1)`, [RF]) });
const denied = (p, sql, a) => assert.rejects(p.query(sql, a), /permission denied/);
let baseline, rep;

test('permissions: nothing in the schema can be run or read except through the two service roles, each limited to its own calls', async () => {
  assert.deepEqual(await O.one(`select nexus.permission_audit()`), { ok: true, functions: 40, service_functions: 20, problems: [] });
  // a login with no role: not even the schema
  await denied(pOut, `select nexus.floor_stop('x', 'HILLSBOROUGH', 'x')`); await denied(pOut, `select nexus.api_map('x')`); await denied(pOut, `select * from nexus.warehouses`); await denied(pOut, `select nexus._hash('x')`);
  // the integration service's login (what an ordinary WMS credential is served through): its seven calls and nothing else
  assert.equal((await on(pApi).one(`select nexus.api_map($1)`, [kMove])).warehouse, RF);
  for (const sql of [`select nexus.floor_stop('x', 'HILLSBOROUGH', 'x')`, `select nexus.baseline_approve('x', gen_random_uuid(), 'x')`, `select nexus.baseline_initialize('x', gen_random_uuid(), 'x', 'x')`, `select nexus.floor_unlock('x', 'HILLSBOROUGH', 'x')`, `select nexus.floor_unlock_approve('x', 'HILLSBOROUGH')`,
    `select nexus.floor_status('x', 'HILLSBOROUGH')`, `select nexus.break_glass_stop('HILLSBOROUGH', 'x')`, `select nexus.operator_create('x', null, 'xx', '{view}', '{HILLSBOROUGH}', false)`, `select nexus.integration_create('x', gen_random_uuid(), 'x', 'HILLSBOROUGH', '{read}')`,
    `select nexus.place('x', 'HILLSBOROUGH', gen_random_uuid(), 'x', 'assign', 'X', 'P-01', null, 'k')`, `select nexus._op('x', '{view}')`, `select nexus._auth('x', 'read')`, `select nexus.location_set('x', 'HILLSBOROUGH', 'P-01', 'blocked', 'x', null)`, `select nexus.rehearsal_floor_create('REHEARSAL-X', 'HILLSBOROUGH')`,
    `select * from nexus.operators`, `select * from nexus.integrations`, `select * from nexus.occupancy`, `update nexus.warehouses set moves_enabled = true`, `insert into nexus.unlock_approvals (warehouse, company_id, operator_id) values ('HILLSBOROUGH', gen_random_uuid(), gen_random_uuid())`, `select * from nexus.key_handoff`])
    await denied(pApi, sql);
  // the admin service's login: the controls, and nothing else (no movement, no key or operator creation, no tables, no break-glass)
  assert.equal((await on(pAdmin).one(`select nexus.floor_status($1, $2)`, [tok.viewer, RF])).ok, true);
  for (const sql of [`select nexus.api_place('x', 'assign', 'X', 'P-01', null, 'k')`, `select nexus.place('x', 'HILLSBOROUGH', gen_random_uuid(), 'x', 'assign', 'X', 'P-01', null, 'k')`, `select nexus.operator_create('x', null, 'xx', '{view}', '{HILLSBOROUGH}', false)`, `select nexus.integration_create('x', gen_random_uuid(), 'x', 'HILLSBOROUGH', '{read}')`,
    `select nexus.break_glass_stop('HILLSBOROUGH', 'x')`, `select nexus.rehearsal_floor_create('REHEARSAL-X', 'HILLSBOROUGH')`, `select nexus._op('x', '{view}')`, `select nexus._floor_gate(gen_random_uuid(), 'x', 'HILLSBOROUGH')`, `select * from nexus.operators`, `select * from nexus.baselines`,
    `update nexus.warehouses set moves_enabled = true`, `update nexus.unlock_approvals set voided_at = null`, `delete from nexus.audit_log`]) await denied(pAdmin, sql);
  // a function added later without permissions set is caught by the audit (PostgreSQL would let everyone run it)
  await O.q(`create function nexus.forgotten() returns int language sql as 'select 1'`); const bad = await O.one(`select nexus.permission_audit()`);
  assert.equal(bad.ok, false); assert.deepEqual([...new Set(bad.problems.map((p) => p.code))].sort(), ['function_default_acl', 'role_can_run']); assert.equal(await on(pApi).one(`select nexus.forgotten()`), 1, 'and it really is runnable until fixed');
  await O.q(`drop function nexus.forgotten()`); assert.equal((await O.one(`select nexus.permission_audit()`)).ok, true);
});
test('credentials and addresses: no token, wrong token, an integration key, the public service', async () => {
  assert.equal((await A(null, 'GET', '/status')).http, 401); assert.equal((await A('nxo_' + 'f'.repeat(64), 'GET', '/status')).http, 401); assert.equal((await A(kMove, 'GET', '/status')).http, 401, 'a WMS integration key is not an operator token');
  assert.equal((await http(svc.url, null, 'GET', `/admin/v1/floors/${RF}/status?token=${tok.viewer}`)).http, 400);
  assert.equal((await http(pub.url, tok.init, 'GET', '/v1/map')).http, 401, 'an operator token is not an integration key');
  for (const p of [`/admin/v1/floors/${RF}/status`, `/v1/admin/floors/${RF}/stop`, `/v1/floors/${RF}/unlock`]) assert.equal((await http(pub.url, kMove, 'GET', p)).http, 404, 'the public integration service has no administrator paths');
  assert.equal((await http(pub.url, kMove, 'POST', `/admin/v1/floors/${RF}/stop`, { reason: 'x' })).http, 404);
  const blocked = (await O.q(`select actor, after ->> 'reason' r from nexus.audit_log where action = 'control_refused' order by id`)); assert.ok(blocked.length >= 2 && blocked.every((b) => b.actor === 'unknown operator' && b.r === 'unauthorized'), 'refused sign-ins are recorded without the token');
});
test('synthetic mode cannot reach HILLSBOROUGH: not by address, not by a synthetic operator, not by a mis-started service', async () => {
  for (const who of ['init', 'unlock', 'souled', 'realFloor']) for (const [m, p, b] of [['GET', '/status'], ['POST', '/stop', { reason: 'x' }], ['POST', '/unlock', { confirm: `UNLOCK ${REAL}` }], ['POST', '/unlock-approval'], ['POST', '/baselines', { report: {} }], ['POST', '/capacity', { position: 'P-01', capacity: 1, specification: 'xxx' }]]) {
    const r = await http(svc.url, tok[who], m, `/admin/v1/floors/${REAL}${p}`, b); assert.deepEqual([r.http, r.error], [403, 'floor_not_allowed'], `${who} ${p}`);
  }
  assert.equal((await http(svc.url, tok.init, 'GET', '/admin/v1/floors/HILLSBOROUGH-TEST/status')).error, 'floor_not_allowed');
  for (const opt of [{ mode: 'synthetic', floors: [RF, REAL] }, { mode: 'synthetic', floors: [REAL] }, { mode: 'live', floors: [RF] }, { mode: 'synthetic', floors: [] }, { floors: [RF] }, { mode: 'test', floors: [RF] }]) assert.throws(() => makeAdminHandler(async () => [], opt));
  // even straight at the database, past the service: a synthetic operator is refused on the real floor, and a real-floor operator on the rehearsal floor
  const D = on(owner); const call = (fn, ...a) => D.one(`select nexus.${fn}(${a.map((_, i) => `$${i + 1}`).join(', ')})`, a);
  for (const [fn, ...a] of [['floor_stop', tok.souled, REAL, 'x'], ['floor_unlock', tok.unlock, REAL, `UNLOCK ${REAL}`], ['floor_unlock_approve', tok.souled, REAL], ['floor_status', tok.viewer, REAL], ['discrepancy_open', tok.souled, REAL, 'P-01', 'xx', 'xxx'], ['location_capacity_verify', tok.init, REAL, 'P-01', 1, 'xxx']])
    assert.equal((await call(fn, ...a)).error, 'wrong_floor', fn);
  assert.equal((await call('baseline_submit', tok.init, REAL, await report())).error, 'wrong_floor');
  assert.equal((await call('floor_status', tok.realFloor, RF)).error, 'wrong_floor'); await O.q(`update nexus.operators set floors = array_append(floors, $1::text) where name like 'Local stand-in%'`, [RF]);
  assert.equal((await call('floor_stop', tok.realFloor, RF, 'x')).error, 'rehearsal_floor', 'a real-floor operator cannot be exercised on a rehearsal floor');
  await O.q(`update nexus.operators set floors = array_append(floors, $1::text) where name = 'Syn Unlocker'`, [REAL]); assert.equal((await call('floor_unlock', tok.unlock, REAL, `UNLOCK ${REAL}`)).error, 'synthetic_operator', 'even mis-assigned, a synthetic operator cannot act on a real floor');
  await assert.rejects(mkOp(null, 'Bad', ['view'], [REAL], true), /not a rehearsal floor/); await assert.rejects(mkOp(null, 'Bad', ['view'], [], true), /at least one floor/); await assert.rejects(O.one(`select nexus.rehearsal_floor_create('FLOOR-2', $1)`, [REAL]), /REHEARSAL-/);
  assert.equal(await state(REAL), 'not_initialized/false'); assert.equal(await O.one(`select count(*)::int from nexus.audit_log where warehouse = $1 and action <> 'control_refused'`, [REAL]), 0);
});
test('baseline: review, no self-approval, wrong roles, stale fingerprints, replayed approvals, both companies required', async () => {
  for (const p of POSITIONS.filter((x) => x.code !== 'P-66')) assert.equal((await A('init', 'POST', '/capacity', { position: p.code, capacity: 1, specification: 'synthetic spec sheet' })).ok, true);
  assert.equal((await A('souled', 'POST', '/capacity', { position: 'P-66', capacity: 1, specification: 'synthetic' })).http, 403);
  const first = await report({ ...FLOOR, 'P-40': ['SHIPBAY', 'SYN-B-OLD'] }); const old = await A('init', 'POST', '/baselines', { report: first }); assert.equal(old.ok, true);
  rep = await report(); const sub = await A('souled2', 'POST', '/baselines', { report: rep }); assert.deepEqual([sub.http, sub.status], [200, 'submitted']); baseline = sub.baseline;
  // review: each company's approver sees its own pallet ids and only the company for the other's
  const seenBySouled = await A('souled', 'GET', `/baselines/${baseline}`); assert.deepEqual(seenBySouled.occupied, [{ position: 'P-01', company: 'SOULED', pallet: 'SYN-S-1' }, { position: 'P-02', company: 'SOULED', pallet: 'SYN-S-2' }, { position: 'P-31', company: 'SHIPBAY' }]);
  assert.deepEqual([seenBySouled.fingerprint, seenBySouled.fingerprint_matches_contents, seenBySouled.map_is_current, seenBySouled.problems_now, seenBySouled.still_needed_from, seenBySouled.by_company], [rep.baseline_fingerprint, true, true, [], ['SHIPBAY', 'SOULED'], { SOULED: 2, SHIPBAY: 1 }]);
  assert.deepEqual((await A('shipbay', 'GET', `/baselines/${baseline}`)).occupied.map((o) => o.pallet ?? null), [null, null, 'SYN-B-1']); assert.equal((await A('viewer', 'GET', `/baselines/${baseline}`)).occupied.length, 3);
  assert.equal((await A('init', 'GET', `/baselines/00000000-0000-4000-8000-000000000000`)).http, 404); assert.equal((await A('init', 'POST', `/baselines/not-an-id/approve`, {})).http, 404);
  // stale: the superseded baseline, and the current baseline with the superseded one's fingerprint
  assert.deepEqual([(await A('souled', 'POST', `/baselines/${old.baseline}/approve`, { fingerprint: first.baseline_fingerprint })).error, (await A('souled', 'POST', `/baselines/${baseline}/approve`, { fingerprint: first.baseline_fingerprint })).error], ['baseline_closed', 'fingerprint_mismatch']);
  // wrong roles and self-approval
  assert.deepEqual([(await A('init', 'POST', `/baselines/${baseline}/approve`, { fingerprint: rep.baseline_fingerprint })).http, (await A('unlock', 'POST', `/baselines/${baseline}/approve`, { fingerprint: rep.baseline_fingerprint })).http, (await A('viewer', 'POST', `/baselines/${baseline}/approve`, { fingerprint: rep.baseline_fingerprint })).http], [403, 403, 403]);
  assert.deepEqual((({ http: h, error }) => [h, error])(await A('souled2', 'POST', `/baselines/${baseline}/approve`, { fingerprint: rep.baseline_fingerprint })), [403, 'not_independent'], 'the submitter cannot approve their own submission');
  assert.equal((await A('init', 'POST', `/baselines/${baseline}/initialize`, { fingerprint: rep.baseline_fingerprint, backup: 'synthetic-backup-1' })).error, 'not_approved');
  // Souled approves; the same approval sent three more times changes nothing; a second Souled person cannot stand in for ShipBay
  const a1 = await A('souled', 'POST', `/baselines/${baseline}/approve`, { fingerprint: rep.baseline_fingerprint }); assert.deepEqual([a1.status, a1.still_needed_from], ['submitted', ['SHIPBAY']]);
  for (let i = 0; i < 3; i++) assert.deepEqual((await A('souled', 'POST', `/baselines/${baseline}/approve`, { fingerprint: rep.baseline_fingerprint })).still_needed_from, ['SHIPBAY']);
  assert.deepEqual([await O.one(`select count(*)::int from nexus.baseline_approvals where baseline_id = $1`, [baseline]), await O.one(`select count(*)::int from nexus.audit_log where action = 'baseline_approved' and target = $1`, [baseline])], [1, 1], 'one approval, recorded once');
  assert.equal((await A('init', 'POST', `/baselines/${baseline}/initialize`, { fingerprint: rep.baseline_fingerprint, backup: 'synthetic-backup-1' })).error, 'not_approved', 'one company is not enough');
  assert.equal((await A('shipbay', 'POST', `/baselines/${baseline}/approve`, { fingerprint: rep.baseline_fingerprint })).status, 'approved');
});
test('initialize and unlock are separate permissions; unlock needs verified capacity and a go from each company', async () => {
  for (const who of ['souled', 'shipbay', 'unlock', 'viewer']) assert.equal((await A(who, 'POST', `/baselines/${baseline}/initialize`, { fingerprint: rep.baseline_fingerprint, backup: 'synthetic-backup-1' })).http, 403, `${who} cannot initialize`);
  assert.equal((await A('init', 'POST', `/baselines/${baseline}/initialize`, { fingerprint: rep.baseline_fingerprint })).error, 'backup_required'); assert.equal((await A('init', 'POST', `/baselines/${baseline}/initialize`, { fingerprint: 'c'.repeat(64), backup: 'synthetic-backup-1' })).error, 'fingerprint_mismatch');
  await assert.rejects(owner.query(`update nexus.warehouses set occupancy_state = 'verified' where code = $1`, [RF]), /only by initializing an approved baseline/, 'the table itself refuses a floor marked verified by hand');
  const i = await A('init', 'POST', `/baselines/${baseline}/initialize`, { fingerprint: rep.baseline_fingerprint, backup: 'synthetic-backup-1' }); assert.deepEqual([i.pallets, i.occupancy_state, i.moves_enabled], [3, 'verified', false]); assert.equal(await state(RF), 'verified/false');
  assert.equal((await A('init', 'POST', '/unlock', { confirm: `UNLOCK ${RF}` })).http, 403, 'the person who may initialize may not unlock'); assert.equal((await A('souled', 'POST', '/unlock', { confirm: `UNLOCK ${RF}` })).http, 403);
  await assert.rejects(owner.query(`update nexus.warehouses set moves_enabled = true where code = $1`, [RF]), /only by the unlock control/, 'the table itself refuses movements switched on by hand');
  assert.equal((await A('unlock', 'POST', '/unlock', {})).error, 'confirmation_required');
  const cap = await A('unlock', 'POST', '/unlock', { confirm: `UNLOCK ${RF}` }); assert.deepEqual([cap.error, cap.positions], ['capacity_not_verified', 1]);
  assert.equal((await A('init', 'POST', '/capacity', { position: 'P-66', capacity: 1, specification: 'synthetic spec sheet' })).map_changed, false);
  assert.deepEqual((await A('unlock', 'POST', '/unlock', { confirm: `UNLOCK ${RF}` })).still_needed_from, ['SHIPBAY', 'SOULED']);
  for (const who of ['init', 'unlock', 'viewer']) assert.equal((await A(who, 'POST', '/unlock-approval')).http, 403, `${who} cannot give a company's go`);
  assert.deepEqual([(await A('souled', 'POST', '/unlock-approval')).already_given, (await A('souled', 'POST', '/unlock-approval')).already_given, (await A('souled', 'POST', '/unlock-approval')).already_given], [false, true, true]); await A('souled2', 'POST', '/unlock-approval');
  assert.deepEqual((await A('unlock', 'POST', '/unlock', { confirm: `UNLOCK ${RF}` })).still_needed_from, ['SHIPBAY'], 'Souled\'s go, however often repeated, is one company');
  const d = await A('shipbay', 'POST', '/discrepancies', { position: 'P-31', kind: 'recheck', detail: 'synthetic: recheck requested' }); await A('shipbay', 'POST', '/unlock-approval');
  assert.equal((await A('unlock', 'POST', '/unlock', { confirm: `UNLOCK ${RF}` })).error, 'open_discrepancies'); assert.equal((await A('viewer', 'POST', `/discrepancies/${d.discrepancy}/resolve`, { resolution: 'xxx' })).http, 403); assert.equal((await A('souled', 'POST', `/discrepancies/999999/resolve`, { resolution: 'xxx' })).http, 404);
  assert.equal((await A('souled', 'POST', `/discrepancies/${d.discrepancy}/resolve`, { resolution: 'rechecked on the floor' })).ok, true);
  const u = await A('unlock', 'POST', '/unlock', { confirm: `UNLOCK ${RF}` }); assert.deepEqual([u.http, u.moves_enabled, u.changed], [200, true, true]);
  assert.equal((await O.one(`select nexus.api_place($1, 'move', 'SYN-S-1', 'P-03', 'P-01', 'adm-1')`, [kMove])).ok, true, 'the floor is open');
});
test('emergency stop: immediate, cancels every go, and works with the administrator interface down', async () => {
  assert.equal((await A('viewer', 'POST', '/stop', { reason: 'x' })).http, 403); assert.equal(await gos(), 3);
  const s = await A('shipbay', 'POST', '/stop', { reason: 'synthetic: pallet seen where Nexus shows none' }); assert.deepEqual([s.http, s.moves_enabled, s.changed], [200, false, true]);
  assert.deepEqual([await state(RF), await gos()], ['verified/false', 0]); assert.equal((await O.one(`select nexus.api_place($1, 'move', 'SYN-S-1', 'P-04', null, 'adm-2')`, [kMove])).error, 'occupancy_not_initialized', 'the very next movement request is refused');
  assert.deepEqual((await A('unlock', 'POST', '/unlock', { confirm: `UNLOCK ${RF}` })).still_needed_from, ['SHIPBAY', 'SOULED'], 'no unlock on the old approvals');
  await A('souled', 'POST', '/unlock-approval'); assert.deepEqual((await A('unlock', 'POST', '/unlock', { confirm: `UNLOCK ${RF}` })).still_needed_from, ['SHIPBAY']);
  await A('shipbay', 'POST', '/unlock-approval'); assert.equal((await A('unlock', 'POST', '/unlock', { confirm: `UNLOCK ${RF}` })).moves_enabled, true);
  // the administrator interface is gone
  await svc.close(); await assert.rejects(fetch(svc.url + `/admin/v1/floors/${RF}/status`));
  // 1. the database owner's stop, no token needed
  const bg = await O.one(`select nexus.break_glass_stop($1, 'synthetic: interface down')`, [RF]); assert.deepEqual([bg.ok, bg.changed], [true, true]); assert.deepEqual([await state(RF), await gos()], ['verified/false', 0]);
  assert.equal((await O.one(`select nexus.api_place($1, 'move', 'SYN-S-1', 'P-04', null, 'adm-3')`, [kMove])).error, 'occupancy_not_initialized');
  // reopen through the controls called directly (still no interface), then 2. a bare UPDATE with no function at all
  const D = (fn, ...a) => O.one(`select nexus.${fn}(${a.map((_, i) => `$${i + 1}`).join(', ')})`, a);
  assert.equal((await D('floor_unlock', tok.unlock, RF, `UNLOCK ${RF}`)).error, 'unlock_not_approved'); await D('floor_unlock_approve', tok.souled, RF); await D('floor_unlock_approve', tok.shipbay, RF); assert.equal((await D('floor_unlock', tok.unlock, RF, `UNLOCK ${RF}`)).moves_enabled, true);
  await owner.query(`update nexus.warehouses set moves_enabled = false where code = $1`, [RF]); assert.deepEqual([await state(RF), await gos()], ['verified/false', 0], 'a plain UPDATE is just as safe: the table cancels the gos');
  assert.equal((await D('floor_unlock', tok.unlock, RF, `UNLOCK ${RF}`)).error, 'unlock_not_approved');
  const last = (await O.q(`select actor, after from nexus.audit_log where warehouse = $1 and action = 'movements_stopped' order by id desc limit 2`, [RF]));
  assert.match(last[0].actor, /^db:postgres$/); assert.equal(last[0].after.reason, '(switched off directly in the database)'); assert.equal(last[1].after.break_glass, true);
  svc = await serveAdmin(`postgres://t_nexus_admin@${host}/${DBN}`, { mode: 'synthetic', floors: [RF] });
  assert.equal((await A('souled', 'POST', '/stop', { reason: 'pressed again while already stopped' })).changed, false);
});
test('audit: every approval, go, unlock, stop and refusal carries who, when, which floor and what was decided', async () => {
  const st = await A('viewer', 'GET', '/status'); assert.deepEqual([st.occupancy_state, st.moves_enabled, st.capacity_unverified, st.open_discrepancies.length], ['verified', false, 0, 0]);
  const rows = await O.q(`select actor, action, warehouse, at, after from nexus.audit_log where warehouse = $1 order by id`, [RF]); const by = (a) => rows.filter((r) => r.action === a);
  assert.ok(rows.every((r) => r.at && r.warehouse === RF && (/^op:[0-9a-f-]{36} Syn /.test(r.actor) || /^db:/.test(r.actor) || /^op:.* Local stand-in/.test(r.actor))), 'identity, time and floor on every entry');
  assert.deepEqual(by('baseline_approved').map((r) => [r.actor.replace(/^op:\S+ /, ''), r.after.company, r.after.fingerprint]), [['Syn Souled Approver', 'SOULED', rep.baseline_fingerprint], ['Syn ShipBay Approver', 'SHIPBAY', rep.baseline_fingerprint]]);
  assert.equal(by('occupancy_initialized')[0].after.backup, 'synthetic-backup-1'); assert.equal(by('unlock_approved').length, 7, 'a go sent again is not recorded twice');
  assert.deepEqual(by('movements_enabled')[0].after.approved_by.map((x) => `${x.company}:${x.by}`), ['SHIPBAY:Syn ShipBay Approver', 'SOULED:Syn Souled Approver', 'SOULED:Syn Souled Second'].sort(), 'an unlock records whose go it rested on');
  assert.deepEqual(by('movements_stopped').map((r) => r.after.reason), ['synthetic: pallet seen where Nexus shows none', 'synthetic: interface down', '(switched off directly in the database)', 'pressed again while already stopped']);
  const refused = await O.q(`select actor, warehouse, after ->> 'reason' r from nexus.audit_log where action = 'control_refused'`); assert.ok(refused.some((r) => r.r === 'forbidden' && /Syn Initializer/.test(r.actor)) && refused.some((r) => r.r === 'wrong_floor' && r.warehouse === REAL) && refused.some((r) => r.r === 'synthetic_operator'));
  assert.ok(!JSON.stringify(await O.q(`select * from nexus.audit_log`)).match(/nxo_[0-9a-f]{20}/), 'no token is ever written to the audit log');
  assert.deepEqual(st.audit.filter((x) => x.action === 'movements_stopped').length, 4, 'the same trail is what the status view shows');
  // and through all of it the real floor in this database was never touched
  assert.equal(await state(REAL), 'not_initialized/false'); assert.equal(await O.one(`select (select count(*) from nexus.pallets where warehouse = $1) + (select count(*) from nexus.baselines where warehouse = $1) + (select count(*) from nexus.unlock_approvals where warehouse = $1) + (select count(*) from nexus.locations where warehouse = $1 and capacity_verified)`, [REAL]), '0');
  assert.equal((await O.one(`select nexus.permission_audit()`)).ok, true);
});
