// Hardened administrator access on a throwaway local database: `node --test neutral/test/hardening.test.mjs`.
// Synthetic operators and a rehearsal floor only. The floor called HILLSBOROUGH here is a copy inside the throwaway
// database. No hosted system is touched. Where a test needs time to pass (a session expiring, a lock ending, the next
// authenticator code), the database owner moves the stored timestamp instead of the test waiting.
import test from 'node:test'; import assert from 'node:assert/strict'; import pg from 'pg'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { createHmac } from 'node:crypto';
import { validate, POSITIONS } from '../baseline/validate.mjs'; import { serveAdmin } from '../service/admin-server.mjs'; import { makeAdminHandler } from '../service/admin.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)); const host = '127.0.0.1:54318'; const DBN = 'nexushard';
const boot = new pg.Client(`postgres://postgres@${host}/postgres`); await boot.connect(); await boot.query(`drop database if exists ${DBN}`); await boot.query(`create database ${DBN}`);
const owner = new pg.Pool({ connectionString: `postgres://postgres@${host}/${DBN}` });
for (const f of ['001_core.sql', '002_floor_map.sql', '003_calendar.sql', '004_baseline.sql', '005_key_handoff.sql', '006_admin_controls.sql', '007_destinations_only.sql', '008_admin_hardening.sql', '009_owner_role.sql']) await owner.query(fs.readFileSync(path.join(here, '..', f), 'utf8'));
// four database logins: the integration service's, the admin service's, the person who manages operators, and one with nothing
for (const [r, g] of [['t_h_api', 'nexus_api'], ['t_h_admin', 'nexus_admin_api'], ['t_h_sec', 'nexus_security_admin'], ['t_h_out', null]]) {
  await owner.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} login; end if; end $$`); if (g) await owner.query(`grant ${g} to ${r}`);
  await owner.query(`grant connect on database ${DBN} to ${r}`);
}
const as = (role) => new pg.Pool({ connectionString: `postgres://${role}@${host}/${DBN}`, max: 3 }); const pApi = as('t_h_api'), pAdmin = as('t_h_admin'), pSec = as('t_h_sec'), pOut = as('t_h_out');
const on = (p) => ({ q: async (sql, a) => (await p.query(sql, a)).rows, one: async (sql, a) => Object.values((await p.query(sql, a)).rows[0])[0] }); const O = on(owner), S = on(pSec), AD = on(pAdmin);
const RF = 'REHEARSAL-01', REAL = 'HILLSBOROUGH', T = '2026-12-05T09:00:00-05:00';
await O.q(`insert into nexus.companies (code, name) values ('SOULED', 'Souled Worldwide'), ('SHIPBAY', 'ShipBay3PL')`); await O.one(`select nexus.rehearsal_floor_create($1, $2)`, [RF, REAL]);
const SOULED = await O.one(`select id from nexus.companies where code = 'SOULED'`);
const enroll = (person, company, name, roles, floors = [RF], synthetic = true) => S.one(`select nexus.operator_enroll($1, $2, $3, $4, $5, $6)`, [person, company, name, roles, floors, synthetic]);
const op = { init: await enroll('syn.init@example.test', null, 'Syn Initializer', ['initialize', 'registry', 'view']), unlock: await enroll('syn.unlock@example.test', null, 'Syn Unlocker', ['unlock']),
  souled: await enroll('syn.souled@example.test', 'SOULED', 'Syn Souled Approver', ['approve_baseline', 'stop']), souled2: await enroll('syn.souled2@example.test', 'SOULED', 'Syn Souled Second', ['approve_baseline']),
  shipbay: await enroll('syn.shipbay@example.test', 'SHIPBAY', 'Syn ShipBay Approver', ['approve_baseline', 'stop']), viewer: await enroll('syn.viewer@example.test', null, 'Syn Viewer', ['view']) };
const kMove = await O.one(`select nexus.integration_create('test', $1, 'souled-syn', $2, '{read,move}')`, [SOULED, RF]);
const WIDE = { perAddress: [100000, 60], signIn: [100000, 60], breakGlass: [100000, 60], write: [100000, 60], read: [100000, 60] };   // limits are tested on their own, below
const svc = await serveAdmin(`postgres://t_h_admin@${host}/${DBN}`, { mode: 'synthetic', floors: [RF], allow: ['127.0.0.1/32'], limits: WIDE });
test.after(async () => { await svc.close().catch(() => {}); for (const p of [pApi, pAdmin, pSec, pOut, owner]) await p.end(); await boot.end(); });
// an authenticator app, as a person's phone would run it
const b32 = (s) => { let bits = ''; for (const c of s) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0'); return Buffer.from(bits.slice(0, Math.floor(bits.length / 8) * 8).match(/.{8}/g).map((b) => parseInt(b, 2))); };
const totp = (secret, step) => { const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(step)); const h = createHmac('sha1', b32(secret)).update(m).digest(); const o = h[19] & 15; return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, '0'); };
const step = () => O.one(`select floor(extract(epoch from clock_timestamp()) / 30)::int`);
const sameCode = async (who) => totp(op[who].authenticator_secret, await step());
const code = async (who) => { await O.q(`update nexus.operator_mfa set last_step = 0 where operator_id = $1`, [op[who].operator]); return sameCode(who); };   // "thirty seconds later"
const H = async (token, method, p, body, headers = {}) => { const r = await fetch(svc.url + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }); return { http: r.status, retryAfter: r.headers.get('retry-after'), requestId: r.headers.get('x-request-id'), ...(await r.json()) }; };
const sess = {};
const signIn = async (who) => { const r = await H(null, 'POST', '/admin/v1/session', { credential: op[who].credential, code: await code(who) }); assert.equal(r.http, 200, `${who} signs in: ${r.error}`); sess[who] = r.session; return r; };
const confirm = async (who) => H(sess[who], 'POST', '/admin/v1/session/confirm', { code: await code(who) });
const A = (who, method, p, body) => H(sess[who] ?? who, method, `/admin/v1/floors/${RF}${p}`, body);
const state = async (wh) => (await O.q(`select occupancy_state s, moves_enabled m from nexus.warehouses where code = $1`, [wh])).map((r) => `${r.s}/${r.m}`)[0];
const gos = () => O.one(`select count(*)::int from nexus.unlock_approvals where warehouse = $1 and voided_at is null`, [RF]);
const lastAudit = async (action) => (await O.q(`select actor, warehouse, after from nexus.audit_log where action = $1 order by id desc limit 1`, [action]))[0];
const FLOORPLAN = { 'P-01': ['SOULED', 'SYN-S-1'], 'P-02': ['SOULED', 'SYN-S-2'], 'P-31': ['SHIPBAY', 'SYN-B-1'] };
const sheet = (who) => POSITIONS.map((p) => (FLOORPLAN[p.code] ? { position: p.code, state: 'OCCUPIED', company: FLOORPLAN[p.code][0], pallet_id: FLOORPLAN[p.code][1], counted_by: who, counted_at: T } : { position: p.code, state: 'EMPTY', counted_by: who, counted_at: T }));
const report = async () => validate({ count: sheet('Counter A'), second: sheet('Counter B'), mapVersion: await O.one(`select map_version from nexus.warehouses where code = $1`, [RF]), mapChecksum: await O.one(`select nexus._map_checksum($1)`, [RF]) });
const denied = (p, sql, a) => assert.rejects(p.query(sql, a), /permission denied/, sql);
let baseline, rep;

test('4. least privilege: the schema is owned by a role nobody can log in as, and each login can run only its own short list', async () => {
  const pa = await O.one(`select nexus.permission_audit()`); assert.deepEqual([pa.ok, pa.owner, pa.owner_can_log_in, pa.problems], [true, 'nexus_owner', false, []]); assert.equal(pa.service_functions, 25);
  assert.deepEqual((await O.q(`select rolcanlogin l, rolsuper s, rolcreaterole c, rolcreatedb d, rolbypassrls b, rolpassword is null np from pg_authid where rolname = 'nexus_owner'`))[0], { l: false, s: false, c: false, d: false, b: false, np: true });
  assert.equal(await O.one(`select count(*)::int from pg_class c where c.relnamespace = 'nexus'::regnamespace and c.relowner <> 'nexus_owner'::regrole`), 0, 'every table, index and sequence');
  assert.equal(await O.one(`select count(*)::int from pg_proc p where p.pronamespace = 'nexus'::regnamespace and p.proowner <> 'nexus_owner'::regrole`), 0, 'every function');
  // the admin service's login: six functions. No control directly, no table, no operator management.
  for (const sql of [`select nexus.floor_stop('x', '${RF}', 'x')`, `select nexus.floor_status('x', '${RF}')`, `select nexus.floor_unlock('x', '${RF}', 'x')`, `select nexus.floor_unlock_approve('x', '${RF}')`, `select nexus.baseline_approve('x', gen_random_uuid(), 'x')`,
    `select nexus.baseline_initialize('x', gen_random_uuid(), 'x', 'x')`, `select nexus._op('x', '{view}')`, `select nexus._session('x')`, `select nexus._code_ok(gen_random_uuid(), '000000')`, `select nexus._totp('\\x00', 1)`, `select nexus.break_glass_stop('${RF}', 'x')`,
    `select nexus.operator_enroll('a@b.cc', null, 'xx', '{view}', '{${RF}}', true)`, `select nexus.break_glass_issue('${RF}', 'xx')`, `select nexus.break_glass_review(gen_random_uuid(), 'xxxxxxxxxxxx')`, `select nexus.sessions_revoke(gen_random_uuid(), 'xxx')`, `select nexus.security_overview()`,
    `select nexus.api_place('x', 'assign', 'X', 'P-01', null, 'k')`, `select * from nexus.operators`, `select * from nexus.operator_mfa`, `select * from nexus.operator_sessions`, `select * from nexus.break_glass_codes`, `select * from nexus.audit_log`, `select * from nexus.admin_access_log`,
    `insert into nexus.admin_access_log (control, ok) values ('x', true)`, `delete from nexus.audit_log`, `update nexus.warehouses set moves_enabled = true`, `update nexus.admin_settings set value = 100000`, `create table nexus.x (i int)`]) await denied(pAdmin, sql);
  assert.equal((await AD.one(`select nexus.admin_call('nxs_x', 'floor_status', $1, '{}', '127.0.0.1', 'r')`, [RF])).error, 'unauthorized', 'its one way in to the controls is there, and asks for a session');
  // the operator manager's login: enrol, revoke, break-glass codes, audit checks. No control, no sign-in, no secret, no table.
  for (const sql of [`select nexus.admin_call('x', 'floor_stop', '${RF}', '{}', '127.0.0.1', 'r')`, `select nexus.session_open('x', '000000', 'x')`, `select nexus.break_glass_redeem('${RF}', 'x', 'x', 'x')`, `select nexus.floor_stop('x', '${RF}', 'x')`, `select nexus.floor_unlock('x', '${RF}', 'x')`,
    `select nexus.api_map('x')`, `select nexus.rehearsal_floor_create('REHEARSAL-X', '${REAL}')`, `select nexus.integration_create('x', gen_random_uuid(), 'x', '${REAL}', '{read}')`, `select * from nexus.operator_mfa`, `select * from nexus.operators`, `select * from nexus.operator_sessions`,
    `select * from nexus.break_glass_codes`, `update nexus.operators set roles = '{unlock}'`, `delete from nexus.audit_log`, `update nexus.warehouses set moves_enabled = true`]) await denied(pSec, sql);
  const ov = await S.one(`select nexus.security_overview()`); assert.equal(ov.operators.length, 6); assert.ok(!/nxo_|nxs_|secret|hash/.test(JSON.stringify(ov)), 'the overview carries no credential, hash or secret');
  // the integration service's login and a login with nothing
  for (const sql of [`select nexus.admin_call('x', 'floor_stop', '${RF}', '{}', '127.0.0.1', 'r')`, `select nexus.session_open('x', '000000', 'x')`, `select nexus.break_glass_redeem('${RF}', 'x', 'x', 'x')`, `select nexus.operator_enroll('a@b.cc', null, 'xx', '{view}', '{${RF}}', true)`, `select nexus.security_overview()`, `select * from nexus.operator_sessions`]) await denied(pApi, sql);
  assert.equal((await on(pApi).one(`select nexus.api_map($1)`, [kMove])).warehouse, RF, 'while its own calls still work under the new owner');
  await denied(pOut, `select nexus.admin_call('x', 'floor_stop', '${RF}', '{}', '127.0.0.1', 'r')`); await denied(pOut, `select nexus.session_open('x', '000000', 'x')`); await denied(pOut, `select * from nexus.admin_settings`);
  // a function added later by the owner role is not runnable by anyone else; one added by the wrong login is caught by the audit
  await O.q(`set role nexus_owner; create function nexus.added_later() returns int language sql as 'select 1'; reset role`); await denied(pApi, `select nexus.added_later()`); await denied(pAdmin, `select nexus.added_later()`); assert.equal((await O.one(`select nexus.permission_audit()`)).ok, true);
  await O.q(`drop function nexus.added_later(); create function nexus.wrong_owner() returns int language sql as 'select 1'`); const bad = await O.one(`select nexus.permission_audit()`);
  assert.deepEqual([...new Set(bad.problems.map((p) => p.code))].sort(), ['function_default_acl', 'function_wrong_owner', 'role_can_run']); await O.q(`drop function nexus.wrong_owner()`);
  // a service role given a login, or more power, is caught too
  await O.q(`alter role nexus_admin_api login`); assert.deepEqual((await O.one(`select nexus.permission_audit()`)).problems.map((p) => p.code), ['service_role_login']); await O.q(`alter role nexus_admin_api nologin`);
  await O.q(`grant nexus_owner to nexus_security_admin`); assert.ok((await O.one(`select nexus.permission_audit()`)).problems.some((p) => p.code === 'service_role_powerful')); await O.q(`revoke nexus_owner from nexus_security_admin`);
  assert.equal((await O.one(`select nexus.permission_audit()`)).ok, true);
});

test('1. sign-in: the long-lived credential runs nothing; a session needs the credential and a fresh code, and each code works once', async () => {
  // the credential sent where a session belongs: through the service, and straight at the database
  assert.equal((await A(op.viewer.credential, 'GET', '/status')).http, 401); assert.equal((await O.one(`select nexus.floor_status($1, $2)`, [op.viewer.credential, RF])).error, 'unauthorized');
  assert.equal((await lastAudit('control_refused')).after.reason, 'credential_not_a_session');
  assert.equal((await AD.one(`select nexus.admin_call($1, 'floor_stop', $2, '{"reason":"x"}', '127.0.0.1', 'r')`, [op.souled.credential, RF])).error, 'unauthorized', 'not for a stop either'); assert.equal(await state(RF), 'not_initialized/false');
  // wrong code, no code, a code for another operator, an unknown credential: one answer for all, each recorded
  for (const [cred, c] of [[op.viewer.credential, '000000'], [op.viewer.credential, null], [op.viewer.credential, await code('init')], ['nxo_' + 'f'.repeat(64), await code('viewer')], [null, null]]) {
    const r = await H(null, 'POST', '/admin/v1/session', { credential: cred, code: c }); assert.deepEqual([r.http, r.error, r.message], [401, 'unauthorized', 'sign-in refused']);
  }
  assert.deepEqual((await O.q(`select actor, after ->> 'reason' r, after ->> 'client' c from nexus.audit_log where action = 'signin_refused' order by id`)).map((x) => `${x.actor.replace(/^op:\S+ /, '')}|${x.r}|${x.c}`),
    ['Syn Viewer|bad_code|127.0.0.1', 'Syn Viewer|bad_code|127.0.0.1', 'Syn Viewer|bad_code|127.0.0.1', 'unknown operator|unauthorized|127.0.0.1', 'unknown operator|unauthorized|127.0.0.1']);
  // the right code: a session. The very same code again, seconds later: refused (it has been used).
  await O.q(`update nexus.operator_mfa set last_step = 0 where operator_id = $1`, [op.viewer.operator]); const c1 = await sameCode('viewer');
  const s1 = await H(null, 'POST', '/admin/v1/session', { credential: op.viewer.credential, code: c1 }); assert.equal(s1.http, 200); assert.match(s1.session, /^nxs_[0-9a-f]{64}$/); assert.deepEqual([s1.operator, s1.roles, s1.floors], ['Syn Viewer', ['view'], [RF]]);
  const mins = (Date.parse(s1.expires_at) - Date.now()) / 60000; assert.ok(mins > 14 && mins <= 15, 'a session lasts fifteen minutes');
  assert.equal((await H(null, 'POST', '/admin/v1/session', { credential: op.viewer.credential, code: c1 })).http, 401, 'a code that was seen cannot be replayed');
  assert.equal((await H(s1.session, 'GET', `/admin/v1/floors/${RF}/status`)).http, 200); assert.equal((await H(s1.session, 'POST', '/admin/v1/session/confirm', { code: c1 })).http, 401, 'nor replayed to confirm');
  // a newer sign-in ends the older session; only hashes are stored
  const s2 = await signIn('viewer'); assert.equal((await H(s1.session, 'GET', `/admin/v1/floors/${RF}/status`)).error, 'session_expired'); assert.equal((await A('viewer', 'GET', '/status')).http, 200);
  assert.equal(await O.one(`select count(*)::int from nexus.operator_sessions where token_hash in ($1, $2) or token_hash like 'nxs%'`, [s1.session, s2.session]), 0, 'no session token is stored');
  // five wrong codes in a row: locked, sessions ended, and the right code does not help until the lock ends
  await O.q(`update nexus.operators set failed_signins = 0 where id = $1`, [op.viewer.operator]);
  for (let i = 0; i < 5; i++) assert.equal((await H(null, 'POST', '/admin/v1/session', { credential: op.viewer.credential, code: '123456' })).http, 401);
  const lk = await H(null, 'POST', '/admin/v1/session', { credential: op.viewer.credential, code: await code('viewer') }); assert.deepEqual([lk.http, lk.error], [423, 'locked']); assert.ok(Number(lk.retryAfter) > 800 && Number(lk.retryAfter) <= 900);
  assert.equal((await A('viewer', 'GET', '/status')).http, 401, 'the lock also ended the open session'); assert.equal((await lastAudit('operator_locked')).after.minutes, 15);
  await O.q(`update nexus.operators set locked_until = now() - interval '1 second' where id = $1`, [op.viewer.operator]); await signIn('viewer');
});

test('1. expiry and revocation: a session dies on time, on sign-out, on revocation, on deactivation, on a replaced credential, from another address', async () => {
  await signIn('souled'); assert.equal((await A('souled', 'GET', '/status')).http, 200);
  // fifteen minutes pass
  await O.q(`update nexus.operator_sessions set expires_at = now() - interval '1 second' where operator_id = $1 and closed_at is null`, [op.souled.operator]);
  const ex = await A('souled', 'GET', '/status'); assert.deepEqual([ex.http, ex.error], [401, 'session_expired']); assert.equal((await lastAudit('control_refused')).after.reason, 'session_expired');
  assert.equal((await A('souled', 'POST', '/stop', { reason: 'x' })).http, 401, 'an expired session cannot stop either: that is what break-glass is for'); assert.equal((await confirm('souled')).http, 401, 'and cannot be revived with a code');
  // sign out
  await signIn('souled'); assert.equal((await H(sess.souled, 'DELETE', '/admin/v1/session')).http, 200); assert.equal((await A('souled', 'GET', '/status')).error, 'session_expired');
  // revoked by the operator manager: the next call fails
  await signIn('souled'); assert.equal((await S.one(`select nexus.sessions_revoke($1, 'synthetic: laptop reported lost')`, [op.souled.operator])).sessions_ended, 1); assert.equal((await A('souled', 'GET', '/status')).http, 401);
  assert.deepEqual((({ actor, after }) => [actor, after.reason])(await lastAudit('sessions_revoked')), ['db:t_h_sec', 'synthetic: laptop reported lost'], 'who revoked is their own database login, not a name they typed');
  // the same token from another address is not a session
  await signIn('souled'); const moved = await AD.one(`select nexus.admin_call($1, 'floor_status', $2, '{}', '203.0.113.9', 'r')`, [sess.souled, RF]); assert.equal(moved.error, 'unauthorized'); assert.equal((await lastAudit('control_refused')).after.reason, 'session_wrong_address');
  assert.equal((await A('souled', 'GET', '/status')).http, 200, 'while from its own address it still works');
  // credential replaced: sessions end, the old credential is dead, the new one works
  const rot = await S.one(`select nexus.operator_credential_rotate($1)`, [op.souled.operator]); assert.equal(rot.sessions_ended, 1); assert.equal((await A('souled', 'GET', '/status')).http, 401);
  assert.equal((await H(null, 'POST', '/admin/v1/session', { credential: op.souled.credential, code: await code('souled') })).http, 401); op.souled.credential = rot.credential; await signIn('souled');
  // a credential older than ninety days opens nothing
  await O.q(`update nexus.operators set credential_set_at = now() - interval '91 days' where id = $1`, [op.souled.operator]);
  assert.equal((await H(null, 'POST', '/admin/v1/session', { credential: op.souled.credential, code: await code('souled') })).error, 'credential_expired'); await O.q(`update nexus.operators set credential_set_at = now() where id = $1`, [op.souled.operator]);
  // deactivated: session dead at once, no sign-in. A throwaway operator, so the others stay usable.
  const tmp = await enroll('syn.leaver@example.test', null, 'Syn Leaver', ['view']); op.tmp = tmp; await signIn('tmp'); assert.equal((await A('tmp', 'GET', '/status')).http, 200);
  assert.equal((await S.one(`select nexus.operator_deactivate($1, 'synthetic: left the company')`, [tmp.operator])).sessions_ended, 1); assert.equal((await A('tmp', 'GET', '/status')).http, 401);
  assert.equal((await H(null, 'POST', '/admin/v1/session', { credential: tmp.credential, code: await code('tmp') })).http, 401); assert.equal((await lastAudit('signin_refused')).after.reason, 'operator_inactive');
  // a lost phone: a new authenticator secret, the old one stops working
  const reset = await S.one(`select nexus.operator_mfa_reset($1)`, [op.souled.operator]); assert.equal((await H(null, 'POST', '/admin/v1/session', { credential: op.souled.credential, code: await code('souled') })).http, 401, 'the old authenticator');
  await O.q(`update nexus.operators set failed_signins = 0 where id = $1`, [op.souled.operator]); op.souled.authenticator_secret = reset.authenticator_secret; await signIn('souled');
});

test('5. separation: no record and no person holds two of approve / initialize / unlock, and each control still checks its own role', async () => {
  for (const roles of [['initialize', 'unlock'], ['approve_baseline', 'initialize'], ['approve_baseline', 'unlock'], ['approve_baseline', 'initialize', 'unlock', 'stop']])
    await assert.rejects(enroll('syn.greedy@example.test', 'SOULED', 'Syn Greedy', roles), /cannot hold more than one/, roles.join('+'));
  // the same person under a second record
  await assert.rejects(enroll('SYN.INIT@example.test', null, 'Init Again', ['unlock']), /cannot hold more than one/); await assert.rejects(enroll('syn.unlock@example.test', 'SOULED', 'Unlocker As Approver', ['approve_baseline']), /cannot hold more than one|different company/);
  await assert.rejects(enroll('syn.souled@example.test', 'SHIPBAY', 'Souled As ShipBay', ['stop']), /different company/, 'nor approve for two companies');
  await assert.rejects(enroll('not-an-address', null, 'Nameless', ['view']), /named person/); await assert.rejects(enroll('syn.x@example.test', null, 'No Company Approver', ['approve_baseline']), /check constraint/);
  await assert.rejects(enroll('syn.x@example.test', null, 'Real Floor', ['view'], [REAL], true), /not a rehearsal floor/);
  // not even by hand in the table
  await assert.rejects(owner.query(`update nexus.operators set roles = '{initialize,unlock}' where id = $1`, [op.init.operator]), /operators_separated/);
  assert.equal((await enroll('syn.init@example.test', null, 'Init, second record', ['stop', 'view'])).ok, true, 'stop and view combine with anything');
  // one of each, signed in, with a fresh code: each is refused at every control that is not theirs
  for (const who of ['init', 'unlock', 'shipbay', 'souled2']) await signIn(who);
  const fp = 'a'.repeat(64), id = '00000000-0000-4000-8000-000000000000';
  const tries = { approve: ['POST', `/baselines/${id}/approve`, { fingerprint: fp }], initialize: ['POST', `/baselines/${id}/initialize`, { fingerprint: fp, backup: 'xxx' }], go: ['POST', '/unlock-approval'], unlock: ['POST', '/unlock', { confirm: `UNLOCK ${RF}` }], stop: ['POST', '/stop', { reason: 'x' }] };
  const got = {}; for (const who of ['init', 'unlock', 'souled', 'viewer']) got[who] = Object.fromEntries(await Promise.all(Object.entries(tries).map(async ([k, [m, p, b]]) => [k, (await A(who, m, p, b)).http])));
  // (404 = allowed past the role check, then no such baseline; 409 = allowed, then refused by the floor's state)
  assert.deepEqual(got, { init: { approve: 404, initialize: 404, go: 403, unlock: 403, stop: 403 }, unlock: { approve: 404, initialize: 404, go: 403, unlock: 409, stop: 403 },
    souled: { approve: 404, initialize: 404, go: 409, unlock: 403, stop: 200 }, viewer: { approve: 404, initialize: 404, go: 403, unlock: 403, stop: 403 } });
  // (approve and initialize answer 404 to anyone who may look at the floor: the baseline is looked up first. Their own role checks are exercised with a real baseline in the next test.)
});

test('2+5. the whole ceremony through sessions: approve, initialize and unlock each need their own role AND a code entered minutes ago; stop never waits for one', async () => {
  for (const p of POSITIONS) assert.equal((await A('init', 'POST', '/capacity', { position: p.code, capacity: 1, specification: 'synthetic spec sheet' })).ok, true);
  rep = await report(); const sub = await A('souled2', 'POST', '/baselines', { report: rep }); assert.deepEqual([sub.http, sub.status], [200, 'submitted']); baseline = sub.baseline;
  const approve = (who) => A(who, 'POST', `/baselines/${baseline}/approve`, { fingerprint: rep.baseline_fingerprint }); const init = () => A('init', 'POST', `/baselines/${baseline}/initialize`, { fingerprint: rep.baseline_fingerprint, backup: 'synthetic-backup-1' });
  // with a real baseline, the role checks behind the lookup
  assert.deepEqual([(await approve('init')).http, (await approve('unlock')).http, (await approve('viewer')).http, (await A('souled', 'POST', `/baselines/${baseline}/initialize`, { fingerprint: rep.baseline_fingerprint, backup: 'xxx' })).http, (await A('unlock', 'POST', `/baselines/${baseline}/initialize`, { fingerprint: rep.baseline_fingerprint, backup: 'xxx' })).http], [403, 403, 403, 403, 403]);
  assert.deepEqual((({ http, error }) => [http, error])(await approve('souled2')), [403, 'not_independent']);
  // six minutes after signing in, an approver's code is no longer fresh
  const stale = (who) => O.q(`update nexus.operator_sessions set mfa_at = now() - interval '6 minutes' where operator_id = $1 and closed_at is null`, [op[who].operator]);
  await stale('souled'); const need = await approve('souled'); assert.deepEqual([need.http, need.error, need.within_minutes], [403, 'mfa_required', 5]); assert.equal(await O.one(`select count(*)::int from nexus.baseline_approvals`), 0);
  assert.equal((await A('souled', 'GET', '/status')).http, 200, 'looking still works'); assert.equal((await H(sess.souled, 'POST', '/admin/v1/session/confirm', { code: '000000' })).http, 401);
  assert.equal((await confirm('souled')).http, 200); assert.deepEqual((await approve('souled')).still_needed_from, ['SHIPBAY']); assert.equal((await approve('shipbay')).status, 'approved');
  await stale('init'); assert.equal((await init()).error, 'mfa_required'); assert.equal(await state(RF), 'not_initialized/false'); await confirm('init');
  const i = await init(); assert.deepEqual([i.pallets, i.occupancy_state, i.moves_enabled], [3, 'verified', false]);
  await stale('shipbay'); assert.equal((await A('shipbay', 'POST', '/unlock-approval')).error, 'mfa_required', 'a company\'s go needs a fresh code too'); await confirm('shipbay'); assert.equal((await A('shipbay', 'POST', '/unlock-approval')).already_given, false); await A('souled', 'POST', '/unlock-approval');
  await stale('unlock'); assert.equal((await A('unlock', 'POST', '/unlock', { confirm: `UNLOCK ${RF}` })).error, 'mfa_required'); assert.equal(await state(RF), 'verified/false'); await confirm('unlock');
  const u = await A('unlock', 'POST', '/unlock', { confirm: `UNLOCK ${RF}` }); assert.deepEqual([u.http, u.moves_enabled, u.changed], [200, true, true]);
  assert.equal((await O.one(`select nexus.api_place($1, 'move', 'SYN-S-1', 'P-03', 'P-01', 'hard-1')`, [kMove])).ok, true, 'the floor is open');
  // stop: a live session with the stop role is enough, however old its code
  await stale('shipbay'); const st = await A('shipbay', 'POST', '/stop', { reason: 'synthetic: stop with a stale code' }); assert.deepEqual([st.http, st.moves_enabled, st.changed], [200, false, true]); assert.deepEqual([await state(RF), await gos()], ['verified/false', 0]);
  // reopen for the break-glass test
  await confirm('shipbay'); await A('shipbay', 'POST', '/unlock-approval'); await A('souled', 'POST', '/unlock-approval'); assert.equal((await A('unlock', 'POST', '/unlock', { confirm: `UNLOCK ${RF}` })).moves_enabled, true);
});

test('7. break-glass: a sealed single-use code stops a floor with no session and no authenticator, can do nothing else, and must be reviewed before reopening', async () => {
  await denied(pAdmin, `select nexus.break_glass_issue('${RF}', 'xx')`);
  const bg = await S.one(`select nexus.break_glass_issue($1, 'Synthetic Shift Lead')`, [RF]); assert.match(bg.code, /^([A-Z2-7]{5}-){4}[A-Z2-7]{5}$/); const spare = await S.one(`select nexus.break_glass_issue($1, 'Synthetic Spare')`, [RF]);
  const other = await S.one(`select nexus.break_glass_issue($1, 'Synthetic Other Floor')`, [REAL]); assert.equal(await O.one(`select count(*)::int from nexus.break_glass_codes where code_hash ~ '^[0-9a-f]{64}$'`), 3, 'only hashes are kept');
  const BG = (c, reason = 'synthetic: emergency', floor = RF) => H(null, 'POST', `/admin/v1/floors/${floor}/break-glass-stop`, { code: c, reason });
  // refused: a made-up code, another floor's code, a session token, a credential. All look the same from outside; each is recorded.
  for (const c of ['AAAAA-AAAAA-AAAAA-AAAAA-AAAAA', other.code, sess.shipbay, op.shipbay.credential, '', null]) { const r = await BG(c); assert.deepEqual([r.http, r.error], [401, 'unauthorized']); }
  assert.equal((await BG(other.code, 'x', REAL)).error, 'floor_not_allowed', 'and this service does not act on that floor at all'); assert.equal(await state(RF), 'verified/true');
  assert.deepEqual((await O.q(`select after ->> 'reason' r from nexus.audit_log where action = 'break_glass_refused' order by id`)).map((x) => x.r), ['unknown_code', 'wrong_floor', 'unknown_code', 'unknown_code', 'unknown_code', 'unknown_code']);
  // every operator signed out and locked: the code still works, typed the way a person types from paper
  for (const k of Object.keys(op)) await S.one(`select nexus.sessions_revoke($1, 'synthetic: nobody is signed in')`, [op[k].operator]); assert.equal((await S.one(`select nexus.security_overview()`)).live_sessions.length, 0);
  const r = await BG(' ' + bg.code.toLowerCase().replace(/-/g, ' ') + ' ', 'synthetic: pallet down in the walkway'); assert.deepEqual([r.http, r.moves_enabled, r.changed, r.review_required], [200, false, true, true]);
  assert.deepEqual([await state(RF), await gos()], ['verified/false', 0]); assert.equal((await O.one(`select nexus.api_place($1, 'move', 'SYN-S-1', 'P-04', null, 'hard-2')`, [kMove])).error, 'occupancy_not_initialized', 'the next movement request is refused');
  const a = await lastAudit('movements_stopped'); assert.deepEqual([a.actor, a.warehouse, a.after.break_glass, a.after.holder, a.after.reason, a.after.client], ['break-glass:Synthetic Shift Lead', RF, true, 'Synthetic Shift Lead', 'synthetic: pallet down in the walkway', '127.0.0.1']);
  // used once
  assert.equal((await BG(bg.code)).http, 401); assert.equal((await lastAudit('break_glass_refused')).after.reason, 'already_used');
  // it cannot open anything: with fresh gos from both companies the unlock is still refused until the use is reviewed
  for (const who of ['shipbay', 'souled', 'unlock']) await signIn(who); await A('shipbay', 'POST', '/unlock-approval'); await A('souled', 'POST', '/unlock-approval');
  assert.equal((await A('unlock', 'POST', '/unlock', { confirm: `UNLOCK ${RF}` })).error, 'break_glass_review_pending'); assert.equal(await state(RF), 'verified/false');
  assert.equal((await S.one(`select nexus.break_glass_review($1, 'short')`, [bg.id])).error, 'bad_request'); assert.equal((await S.one(`select nexus.break_glass_review($1, 'synthetic: walkway cleared, count rechecked at P-01 to P-05')`, [bg.id])).ok, true);
  assert.equal((await A('unlock', 'POST', '/unlock', { confirm: `UNLOCK ${RF}` })).moves_enabled, true);
  // an expired code and a revoked code
  await O.q(`update nexus.break_glass_codes set expires_at = now() - interval '1 second' where id = $1`, [spare.id]); assert.equal((await BG(spare.code)).http, 401); assert.equal((await lastAudit('break_glass_refused')).after.reason, 'expired');
  const third = await S.one(`select nexus.break_glass_issue($1, 'Synthetic Third')`, [RF]); await S.one(`select nexus.break_glass_revoke($1, 'synthetic: envelope found open')`, [third.id]); assert.equal((await BG(third.code)).http, 401); assert.equal((await lastAudit('break_glass_refused')).after.reason, 'revoked');
  assert.equal(await state(RF), 'verified/true', 'none of the refused codes stopped anything');
  // last resort, unchanged: the database administrator, in SQL, with the admin service gone
  const last = await O.one(`select nexus.break_glass_stop($1, 'synthetic: admin service down')`, [RF]); assert.deepEqual([last.ok, last.changed], [true, true]); assert.deepEqual([await state(RF), await gos()], ['verified/false', 0]);
  assert.deepEqual((await S.one(`select nexus.security_overview()`)).break_glass.map((c) => c.state).sort(), ['expired', 'revoked', 'sealed', 'used']);
});

test('3. network and request limits: only listed networks, only HTTPS when live, a forwarded address only from our own proxy, and a ceiling on every kind of call', async () => {
  const calls = []; let clock = 1000000; const fake = async (sql, args) => { calls.push([sql.match(/nexus\.(\w+)/)[1], args]); return [{ r: { ok: true } }]; };
  const mk = (o = {}) => makeAdminHandler(fake, { mode: 'synthetic', floors: [RF], allow: ['198.51.100.0/24', '2001:db8::/32'], trustedProxies: ['10.0.0.5'], now: () => clock, ...o });
  const hit = async (h, remote, { method = 'GET', p = `/admin/v1/floors/${RF}/status`, headers = {}, body, scheme = 'http' } = {}) => { const r = await h(new Request(`${scheme}://admin.example.test${p}`, { method, headers: { authorization: 'Bearer nxs_' + 'a'.repeat(64), ...headers }, body: body ? JSON.stringify(body) : undefined }), { remote }); return { http: r.status, retry: r.headers.get('retry-after'), ...(await r.json()) }; };
  let h = mk();
  // networks
  assert.equal((await hit(h, '198.51.100.7')).http, 200); assert.equal((await hit(h, '::ffff:198.51.100.7')).http, 200); assert.equal((await hit(h, '2001:db8::1')).http, 200);
  for (const remote of ['203.0.113.1', '198.51.101.7', '127.0.0.1', '2001:db9::1', '', undefined]) assert.deepEqual((({ http, error }) => [http, error])(await hit(h, remote)), [403, 'network_not_allowed'], String(remote));
  assert.equal((await hit(h, '203.0.113.1', { p: '/admin/v1/health' })).http, 403, 'not even the health check');
  // a forwarded header is believed only from our own proxy, and then only its last hop
  assert.equal((await hit(h, '203.0.113.1', { headers: { 'x-forwarded-for': '198.51.100.7' } })).http, 403, 'an outsider claiming an inside address');
  assert.equal((await hit(h, '10.0.0.5', { headers: { 'x-forwarded-for': '198.51.100.7' } })).http, 200); assert.equal((await hit(h, '10.0.0.5', { headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.1' } })).http, 403, 'the address the proxy itself saw is what counts');
  assert.equal((await hit(h, '10.0.0.5')).http, 403, 'the proxy itself is not an operator');
  assert.equal(calls.filter(([f]) => f === 'admin_call').at(-1)[1][4], '198.51.100.7', 'the database is told the real caller\'s address');
  assert.deepEqual(calls.filter(([f]) => f === 'admin_edge_refusal').map(([, a]) => a[0]).filter((v, i, x) => x.indexOf(v) === i), ['network_not_allowed'], 'refusals are written to the access log');
  assert.ok(calls.filter(([f]) => f === 'admin_edge_refusal').length <= 7, 'at most one record a minute per address, so a flood cannot fill the log');
  // HTTPS
  h = mk({ requireHttps: true }); assert.equal((await hit(h, '198.51.100.7')).error, 'https_required'); assert.equal((await hit(h, '198.51.100.7', { scheme: 'https' })).http, 200);
  assert.equal((await hit(h, '198.51.100.7', { headers: { 'x-forwarded-proto': 'https' } })).error, 'https_required', 'a caller cannot simply claim HTTPS'); assert.equal((await hit(h, '10.0.0.5', { headers: { 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'https' } })).http, 200);
  // a service that would be open to everyone refuses to start
  for (const o of [{ allow: undefined }, { allow: [] }, { allow: ['0.0.0.0/0'] }, { allow: ['::/0'] }, { allow: ['everyone'] }, { allow: ['198.51.100.0/33'] }, { mode: 'live', floors: [REAL], requireHttps: false }, { mode: 'live', floors: [RF] }, { floors: [REAL] }]) assert.throws(() => mk(o), JSON.stringify(o));
  assert.doesNotThrow(() => mk({ mode: 'live', floors: [REAL] }));
  // nothing secret in an address
  h = mk(); for (const q of ['?token=x', '?code=123456', '?x=1']) assert.equal((await hit(h, '198.51.100.7', { p: `/admin/v1/floors/${RF}/status${q}` })).http, 400);
  assert.equal((await hit(h, '198.51.100.7', { headers: { authorization: 'Bearer nxo_' + 'a'.repeat(64) } })).http, 401, 'only something shaped like a session is passed on');
  // limits: sign-in 5 a minute per address, then wait
  h = mk(); const sign = (remote) => hit(h, remote, { method: 'POST', p: '/admin/v1/session', body: { credential: 'x', code: '000000' } });
  for (let i = 0; i < 5; i++) assert.equal((await sign('198.51.100.7')).http, 200); const lim = await sign('198.51.100.7'); assert.deepEqual([lim.http, lim.error, lim.retry], [429, 'rate_limited', '60']);
  assert.equal((await sign('198.51.100.8')).http, 200, 'another address is not affected'); clock += 61000; assert.equal((await sign('198.51.100.7')).http, 200, 'a minute later');
  // break-glass 5 a minute per address; writes 20 a minute per session; everything 120 a minute per address
  h = mk(); const bgs = []; for (let i = 0; i < 6; i++) bgs.push((await hit(h, '198.51.100.7', { method: 'POST', p: `/admin/v1/floors/${RF}/break-glass-stop`, body: { code: 'x' } })).http); assert.deepEqual(bgs, [200, 200, 200, 200, 200, 429]);
  h = mk(); const ws = []; for (let i = 0; i < 21; i++) ws.push((await hit(h, '198.51.100.7', { method: 'POST', p: `/admin/v1/floors/${RF}/stop`, body: { reason: 'x' } })).http); assert.deepEqual([ws.filter((x) => x === 200).length, ws.at(-1)], [20, 429]);
  assert.equal((await hit(h, '198.51.100.9', { method: 'POST', p: `/admin/v1/floors/${RF}/stop`, body: { reason: 'x' }, headers: { authorization: 'Bearer nxs_' + 'b'.repeat(64) } })).http, 200, 'another session is not affected');
  h = mk({ limits: { read: [1000, 60] } }); let n = 0; for (let i = 0; i < 125; i++) if ((await hit(h, '198.51.100.7')).http === 200) n += 1; assert.equal(n, 120);
  // and against the real database: a caller from an unlisted network leaves a record and reaches nothing
  const shut = await serveAdmin(`postgres://t_h_admin@${host}/${DBN}`, { mode: 'synthetic', floors: [RF], allow: ['198.51.100.0/24'] }); const before = await O.one(`select count(*)::int from nexus.audit_log`);
  const r = await fetch(shut.url + `/admin/v1/floors/${RF}/stop`, { method: 'POST', headers: { authorization: `Bearer ${sess.shipbay}`, 'x-forwarded-for': '198.51.100.7', 'content-type': 'application/json' }, body: '{"reason":"x"}' }); assert.equal(r.status, 403); await new Promise((d) => setTimeout(d, 150)); await shut.close();
  assert.deepEqual((await O.q(`select control, client, ok, error from nexus.admin_access_log order by id desc limit 1`))[0], { control: 'edge', client: '127.0.0.1', ok: false, error: 'network_not_allowed' }); assert.equal(await O.one(`select count(*)::int from nexus.audit_log`), before);
});

test('6. audit: every call is on record, allowed or refused, with who, from where and what came of it; the records only grow; later tampering shows', async () => {
  // one allowed call and three kinds of refused call, by request id
  await signIn('viewer'); await signIn('init'); await O.q(`update nexus.operator_sessions set mfa_at = now() - interval '6 minutes' where operator_id = $1 and closed_at is null`, [op.init.operator]);
  const okCall = await A('viewer', 'GET', '/status'), forbidden = await A('viewer', 'POST', '/stop', { reason: 'x' }), noCode = await A('init', 'POST', `/baselines/${baseline}/revert`, { reason: 'synthetic' }), noSession = await A('nxs_' + 'c'.repeat(64), 'GET', '/status');
  const rows = Object.fromEntries((await O.q(`select request, control, warehouse, client, operator_id, session_id is not null s, ok, error from nexus.admin_access_log where request = any ($1)`, [[okCall, forbidden, noCode, noSession].map((x) => x.requestId)])).map((r) => [r.request, r]));
  assert.deepEqual(rows[okCall.requestId], { request: okCall.requestId, control: 'floor_status', warehouse: RF, client: '127.0.0.1', operator_id: op.viewer.operator, s: true, ok: true, error: null });
  assert.deepEqual([rows[forbidden.requestId].control, rows[forbidden.requestId].operator_id, rows[forbidden.requestId].ok, rows[forbidden.requestId].error], ['floor_stop', op.viewer.operator, false, 'forbidden']);
  assert.deepEqual([rows[noCode.requestId].control, rows[noCode.requestId].operator_id, rows[noCode.requestId].error], ['baseline_revert', op.init.operator, 'mfa_required']);
  assert.deepEqual([rows[noSession.requestId].operator_id, rows[noSession.requestId].s, rows[noSession.requestId].error], [null, false, 'unauthorized']);
  // a control that breaks part-way changes nothing, says nothing about the database, and is still recorded
  await signIn('shipbay'); await O.q(`create function nexus.t_boom() returns trigger language plpgsql as 'begin raise exception ''synthetic fault in table %'', tg_table_name; end'; create trigger t_boom before insert on nexus.discrepancies for each row execute function nexus.t_boom()`);
  const boom = await A('shipbay', 'POST', '/discrepancies', { position: 'P-31', kind: 'recheck', detail: 'synthetic: this one fails inside' }); await O.q(`drop trigger t_boom on nexus.discrepancies; drop function nexus.t_boom()`);
  assert.deepEqual([boom.http, boom.error, Object.keys(boom).sort()], [503, 'unavailable', ['error', 'http', 'message', 'ok', 'requestId', 'retryAfter']]); assert.ok(!/synthetic fault|discrepancies/.test(JSON.stringify(boom)));
  assert.deepEqual((await O.q(`select control, ok, error, detail ->> 'cause' cause, operator_id from nexus.admin_access_log where request = $1`, [boom.requestId]))[0], { control: 'discrepancy_open', ok: false, error: 'unavailable', cause: 'synthetic fault in table discrepancies', operator_id: op.shipbay.operator });
  assert.equal(await O.one(`select count(*)::int from nexus.discrepancies`), 0);
  const all = await O.q(`select control, ok, count(*)::int n from nexus.admin_access_log group by 1, 2`); const n = (c, ok) => all.find((r) => r.control === c && r.ok === ok)?.n || 0;
  assert.ok(n('location_capacity_verify', true) === 68 && n('baseline_approve', true) === 2 && n('baseline_initialize', true) === 1 && n('floor_unlock', true) === 3 && n('break_glass_stop', true) === 1 && n('break_glass_stop', false) === 9 && n('baseline_approve', false) >= 5 && n('edge', false) >= 1, JSON.stringify(all));
  // the event trail: who and when on every entry, and the sign-ins
  const ev = await O.q(`select actor, action, at from nexus.audit_log`); assert.ok(ev.every((e) => e.at && /^(op:|db:|break-glass:|unknown operator|test$)/.test(e.actor)));
  for (const a of ['operator_enrolled', 'signed_in', 'signin_refused', 'signed_out', 'confirmed', 'confirm_refused', 'control_refused', 'operator_locked', 'sessions_revoked', 'operator_credential_replaced', 'operator_authenticator_replaced', 'operator_deactivated',
    'baseline_approved', 'occupancy_initialized', 'unlock_approved', 'movements_enabled', 'movements_stopped', 'break_glass_issued', 'break_glass_refused', 'break_glass_revoked', 'break_glass_reviewed']) assert.ok(ev.some((e) => e.action === a), a);
  // no credential, session, authenticator secret or break-glass code anywhere in either record
  const dump = JSON.stringify([await O.q(`select * from nexus.audit_log`), await O.q(`select * from nexus.admin_access_log`)]);
  assert.ok(!/nx[os]_[0-9a-f]{16}/.test(dump)); for (const k of Object.keys(op)) assert.ok(!dump.includes(op[k].authenticator_secret) && !dump.includes(op[k].credential)); assert.ok(!/([A-Z2-7]{5}-){4}[A-Z2-7]{5}/.test(dump));
  // the records only grow, whoever asks
  for (const t of ['audit_log', 'admin_access_log']) for (const sql of [`update nexus.${t} set at = now()`, `delete from nexus.${t}`, `truncate nexus.${t}`]) await assert.rejects(owner.query(sql), /append-only/, sql);
  // a checkpoint, kept elsewhere, shows a later change even by someone able to switch the guard off
  const cp = await S.one(`select nexus.audit_checkpoint()`); assert.match(cp.digest, /^[0-9a-f]{64}$/); assert.deepEqual(await S.one(`select nexus.audit_verify()`), { ok: true, checkpoints: 1, broken: [] });
  await A('viewer', 'GET', '/status'); assert.equal((await S.one(`select nexus.audit_verify()`)).ok, true, 'new entries do not disturb an earlier checkpoint');
  await O.q(`alter table nexus.audit_log disable trigger audit_log_append_only`); assert.ok((await O.one(`select nexus.permission_audit()`)).problems.some((p) => p.code === 'audit_not_append_only'), 'a switched-off guard is itself reported');
  await O.q(`update nexus.audit_log set after = after || '{"reason":"edited"}' where id = (select min(id) from nexus.audit_log where action = 'movements_stopped')`); await O.q(`alter table nexus.audit_log enable trigger audit_log_append_only`);
  assert.deepEqual(await S.one(`select nexus.audit_verify()`), { ok: false, checkpoints: 1, broken: [cp.checkpoint] }); assert.equal((await O.one(`select nexus.permission_audit()`)).ok, true);
  // and through all of it the real floor in this database was never touched
  assert.equal(await state(REAL), 'not_initialized/false');
  assert.equal(await O.one(`select (select count(*) from nexus.pallets where warehouse = $1) + (select count(*) from nexus.baselines where warehouse = $1) + (select count(*) from nexus.unlock_approvals where warehouse = $1) + (select count(*) from nexus.locations where warehouse = $1 and capacity_verified) + (select count(*) from nexus.audit_log where warehouse = $1 and action not in ('break_glass_issued'))`, [REAL]), '0');
});
