// The website's read-only view, on a throwaway local database, with the sign-in service faked: `node --test neutral/test/site.test.mjs`
import test from 'node:test'; import assert from 'node:assert/strict'; import pg from 'pg'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { makeSite } from '../service/site.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)); const base = 'postgres://postgres@127.0.0.1:54318'; const DBN = 'nexussiteview';
const boot = new pg.Client(`${base}/postgres`); await boot.connect(); await boot.query(`drop database if exists ${DBN}`); await boot.query(`create database ${DBN}`); await boot.end();
const db = new pg.Pool({ connectionString: `${base}/${DBN}` });
for (const f of ['001_core.sql', '002_floor_map.sql', '003_calendar.sql', '004_baseline.sql', '005_key_handoff.sql', '007_destinations_only.sql', '010_forward_only.sql', '011_retire_floor.sql', '012_site_view.sql']) await db.query(fs.readFileSync(path.join(here, '..', f), 'utf8'));
test.after(() => db.end());
await db.query(`insert into nexus.companies (code, name) values ('SOULED', 'Souled Worldwide'), ('SHIPBAY', 'ShipBay3PL')`); await db.query(`select nexus.floor_open_forward_only('t', 'HILLSBOROUGH', 'local test fixture only')`);
const USERS = { 'tok-admin-aaaaaaaaaaaaaaaa': ['11111111-1111-4111-8111-111111111111', { role: 'shipbay_admin', active: true }], 'tok-client-aaaaaaaaaaaaaaa': ['22222222-2222-4222-8222-222222222222', { role: 'client_user', active: true }], 'tok-gone-aaaaaaaaaaaaaaaaa': ['33333333-3333-4333-8333-333333333333', { role: 'shipbay_staff', active: false }] };
let calls = 0; let clock = 0;
const fakeAuth = async (url, { headers }) => { calls += 1; const u = USERS[headers.authorization.slice(7)]; assert.equal(headers.apikey, 'anon');
  if (url.endsWith('/auth/v1/user')) return u ? { status: 200, json: async () => ({ id: u[0] }) } : { status: 401, json: async () => ({}) };
  const id = url.match(/id=eq\.([0-9a-f-]+)/)[1]; const row = Object.values(USERS).find((x) => x[0] === id); return { status: 200, json: async () => (row ? [row[1]] : []) }; };
const site = makeSite(async (sql, p) => (await db.query(sql, p)).rows, { authUrl: 'https://auth.example.test', anonKey: 'anon', floor: 'HILLSBOROUGH', roles: ['shipbay_admin', 'shipbay_staff', 'wms_employee'], fetchImpl: fakeAuth, now: () => clock });
const get = async (token, p = '/site/v1/overview', method = 'GET') => { const r = await site(new Request('https://nexus.example.test' + p, { method, headers: token ? { authorization: `Bearer ${token}` } : {} })); return r && { status: r.status, cors: r.headers.get('access-control-allow-origin'), body: r.status === 204 ? null : await r.json() }; };

test('only a signed-in warehouse login reads the view; everyone else is stopped before the database', async () => {
  assert.equal(await get('x', '/v1/map'), null, 'the integration API paths are not this module\'s');
  assert.deepEqual([(await get(null)).status, (await get('short')).status, (await get('tok-unknown-aaaaaaaaaaaaaa')).status, (await get('tok-client-aaaaaaaaaaaaaaa')).status, (await get('tok-gone-aaaaaaaaaaaaaaaaa')).status], [401, 401, 401, 403, 403]);
  assert.deepEqual([(await get('tok-admin-aaaaaaaaaaaaaaaa', '/site/v1/overview', 'POST')).status, (await get('tok-admin-aaaaaaaaaaaaaaaa', '/site/v1/pallets')).status, (await get(null, '/site/v1/overview', 'OPTIONS')).status], [404, 404, 204]);
  const ok = await get('tok-admin-aaaaaaaaaaaaaaaa'); assert.deepEqual([ok.status, ok.cors, ok.body.warehouse, ok.body.map_version, ok.body.checksum, ok.body.positions.length, ok.body.pallets.length, ok.body.occupancy_state], [200, '*', 'HILLSBOROUGH', 4, 'be3cc8f3e9134cb4dfe7d3ac41773bc5d231ed56b4a42c05f5939467d67c8c4f', 69, 0, 'forward_only']);
  const before = calls; await get('tok-admin-aaaaaaaaaaaaaaaa'); assert.equal(calls, before, 'a checked token is trusted for a minute'); clock += 61000; await get('tok-admin-aaaaaaaaaaaaaaaa'); assert.equal(calls, before + 2, 'then checked again');
});
test('it shows the same records the WMSs write, by company and position only', async () => {
  const S = (await db.query(`select id from nexus.companies where code = 'SOULED'`)).rows[0].id, B = (await db.query(`select id from nexus.companies where code = 'SHIPBAY'`)).rows[0].id;
  const kS = (await db.query(`select nexus.integration_create('t', $1, 's', 'HILLSBOROUGH', '{read,move}') k`, [S])).rows[0].k, kB = (await db.query(`select nexus.integration_create('t', $1, 'b', 'HILLSBOROUGH', '{read,move}') k`, [B])).rows[0].k;
  await db.query(`select nexus.api_place_confirmed($1, 'assign', 'PRIV-S-1', 'P-07', null, 'a', 'true', 'Private Person')`, [kS]); await db.query(`select nexus.api_place_confirmed($1, 'assign', 'PRIV-B-1', 'P-40', null, 'b', 'true', 'Private Person')`, [kB]);
  await db.query(`select nexus.api_calendar_put($1, 'EV-1', '{"direction":"inbound","starts_at":"2099-01-05T09:00:00-05:00","pallets":4,"reference":"PRIV-REF","note":"PRIV-NOTE"}')`, [kS]).catch(() => {});
  clock += 61000; const v = (await get('tok-admin-aaaaaaaaaaaaaaaa')).body; const at = (c) => v.positions.find((p) => p.code === c);
  assert.deepEqual([at('P-07').occupants.map((o) => [o.company, o.pallets]), at('P-40').occupants.map((o) => [o.company, o.pallets]), at('P-08').used, at('RCV-DOCK').kind, at('RCV-DOCK').x], [[['SOULED', 1]], [['SHIPBAY', 1]], 0, 'dock', null]);
  assert.deepEqual(v.pallets.map((p) => [p.location, p.company]), [['P-07', 'SOULED'], ['P-40', 'SHIPBAY']]); assert.ok(!/PRIV-|Private Person/.test(JSON.stringify(v)), 'no pallet id, confirmer, reference or note');
  const occ = (await db.query(`select nexus.api_occupancy($1) r`, [kB])).rows[0].r; assert.deepEqual(v.positions.map((p) => [p.code, p.used]), occ.locations.map((l) => [l.code, l.used]), 'position for position the same as the WMS API');
  await db.query(`select nexus.api_place($1, 'release', 'PRIV-S-1', null, 'P-07', 'c')`, [kS]); clock += 1000; assert.equal((await get('tok-admin-aaaaaaaaaaaaaaaa')).body.pallets.length, 1, 'a change by a WMS shows on the next read');
});
