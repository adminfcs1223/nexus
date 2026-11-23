// The integration service over real HTTP, with two stand-in systems ("Souled" and "ShipBay") that know nothing but the
// address and their own key. Throwaway local database, synthetic pallets on the test floor: `node --test neutral/test/service.test.mjs`.
// These prove the Nexus side of the contract. They do not prove either company's real application.
import test from 'node:test'; import assert from 'node:assert/strict'; import pg from 'pg'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { serve } from '../service/server.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)); const base = 'postgres://postgres@127.0.0.1:54318';
const admin = new pg.Client(`${base}/postgres`); await admin.connect(); await admin.query('drop database if exists nexusservice'); await admin.query('create database nexusservice'); await admin.end();
const db = new pg.Pool({ connectionString: `${base}/nexusservice` });
for (const f of ['001_core.sql', '002_floor_map.sql', '003_calendar.sql', ...(process.env.NEXUS_WITH || '').split(',').filter(Boolean)]) await db.query(fs.readFileSync(path.join(here, '..', f), 'utf8'));
const one = async (sql, p) => Object.values((await db.query(sql, p)).rows[0])[0];
const co = (code, name) => one(`insert into nexus.companies (code, name) values ($1, $2) returning id`, [code, name]);
const SOULED = await co('SOULED', 'Souled Worldwide'), SHIPBAY = await co('SHIPBAY', 'ShipBay3PL');
const key = (c, sys, wh, scopes) => one(`select nexus.integration_create('test', $1, $2, $3, $4)`, [c, sys, wh, scopes]);
const all = ['read', 'move', 'calendar'];
const keys = { souled: await key(SOULED, 'souled-wms', 'HILLSBOROUGH-TEST', all), shipbay: await key(SHIPBAY, 'shipbay-wms', 'HILLSBOROUGH-TEST', all),
  souledLive: await key(SOULED, 'souled-wms', 'HILLSBOROUGH', all), shipbayLive: await key(SHIPBAY, 'shipbay-wms', 'HILLSBOROUGH', all), viewer: await key(SHIPBAY, 'shipbay-screen', 'HILLSBOROUGH-TEST', ['read']) };
let svc = await serve(`${base}/nexusservice`); let n = 0;
// a stand-in system: everything it knows about the floor comes from these calls
const sys = (k) => async (method, p, body, idem) => {
  const r = await fetch(svc.url + p, { method, headers: { authorization: `Bearer ${k}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(method === 'POST' ? { 'idempotency-key': idem || `s-${++n}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { ...(await r.json()), status: r.status };
};
const souled = sys(keys.souled), shipbay = sys(keys.shipbay), souledLive = sys(keys.souledLive), shipbayLive = sys(keys.shipbayLive), viewer = sys(keys.viewer);
test.after(async () => { await svc.close(); await db.end(); });

test('keys: header only, never the address; wrong or missing key is turned away; errors carry no internals', async () => {
  assert.equal((await fetch(svc.url + '/v1/health')).status, 200);
  assert.equal((await fetch(svc.url + '/v1/map')).status, 401); assert.equal((await sys('nxk_nope')('GET', '/v1/map')).status, 401);
  const inUrl = await fetch(`${svc.url}/v1/map?key=${keys.souled}`, { headers: { authorization: `Bearer ${keys.souled}` } }); assert.equal(inUrl.status, 400);
  assert.equal((await viewer('POST', '/v1/pallets/assign', { pallet: 'X-1', to: 'P-01' })).status, 403); assert.equal((await viewer('PUT', '/v1/calendar/E-1', { direction: 'inbound', starts_at: '2026-12-01T10:00:00-05:00' })).status, 403);
  assert.equal((await souled('GET', '/v1/nothing')).status, 404);
  const bad = await fetch(svc.url + '/v1/pallets/assign', { method: 'POST', headers: { authorization: `Bearer ${keys.souled}`, 'idempotency-key': 'b1' }, body: '{not json' }); assert.equal(bad.status, 400);
  assert.equal(await one(`select count(*)::int from nexus.integrations where key_hash like 'nxk_%'`), 0, 'no key is stored, only hashes');
});
test('all three draw one map: the same layout and checksum for Souled, ShipBay, and the live floor', async () => {
  const a = await souled('GET', '/v1/map'), b = await shipbay('GET', '/v1/map'), c = await shipbayLive('GET', '/v1/map'), d = await souledLive('GET', '/v1/map');
  assert.deepEqual(a.positions, b.positions); assert.deepEqual(a.landmarks, b.landmarks); assert.equal(new Set([a.checksum, b.checksum, c.checksum, d.checksum]).size, 1);
  const count = (blk) => a.positions.filter((p) => p.block === blk).length;
  assert.deepEqual([count('outbound'), count('inbound'), count('staging'), a.positions.filter((p) => p.kind === 'pallet').length], [36, 30, 2, 66]);
  assert.deepEqual(a.landmarks.map((l) => l.key), ['exit', 'dock', 'walkway', 'entrance', 'prep']); assert.equal(a.map_version, 4); assert.deepEqual(a.not_drawn, []);
  const at = (code) => { const p = a.positions.find((x) => x.code === code); return [p.x, p.y]; };
  assert.deepEqual([at('P-01'), at('P-15'), at('P-16'), at('P-30'), at('P-31'), at('P-48'), at('P-49'), at('P-66'), at('STG-01'), at('STG-02')], [[4, 1], [4, 15], [5, 1], [5, 15], [1, 1], [1, 18], [2, 1], [2, 18], [4, 16], [5, 16]]);
  assert.deepEqual(a.layout.blocks.map((b) => [b.key, b.x, b.y]), [['outbound', [1, 2], [1, 18]], ['walkway', [3, 3], [1, 18]], ['inbound', [4, 5], [1, 15]], ['staging', [4, 5], [16, 16]]]);
  assert.deepEqual(a.positions.filter((p) => p.kind === 'pallet').map((p) => p.code).sort(), Array.from({ length: 66 }, (_, i) => `P-${String(i + 1).padStart(2, '0')}`));
});
test('the live floor over HTTP: empty, marked not initialized, and locked for both companies', async () => {
  for (const s of [souledLive, shipbayLive]) {
    const o = await s('GET', '/v1/occupancy'); assert.deepEqual([o.occupancy_state, o.moves_enabled, o.locations.reduce((t, l) => t + l.used, 0)], ['not_initialized', false, 0]);
    for (const [act, body] of [['assign', { pallet: 'REAL-1', to: 'P-01' }], ['move', { pallet: 'REAL-1', to: 'P-02' }], ['release', { pallet: 'REAL-1' }]]) {
      const r = await s('POST', `/v1/pallets/${act}`, body); assert.deepEqual([r.status, r.error], [423, 'occupancy_not_initialized']);
    }
  }
  assert.equal(await one(`select count(*)::int from nexus.pallets where warehouse = 'HILLSBOROUGH'`), 0);
});
test('synthetic assign, move, conflict and release between the two systems', async () => {
  const a = await souled('POST', '/v1/pallets/assign', { pallet: 'SYN-S-1', to: 'P-37' }); assert.deepEqual([a.status, a.ok, a.location], [200, true, 'P-37']);
  const seen = (await shipbay('GET', '/v1/occupancy')).locations.find((l) => l.code === 'P-37'); assert.deepEqual([seen.used, seen.occupants, seen.your_pallets], [1, [{ company: 'SOULED', pallets: 1 }], []]);
  const clash = await shipbay('POST', '/v1/pallets/assign', { pallet: 'SYN-B-1', to: 'P-37' }); assert.deepEqual([clash.status, clash.error], [409, 'location_full']);
  assert.deepEqual([(await shipbay('POST', '/v1/pallets/assign', { pallet: 'SYN-B-1', to: 'P-67' })).error, (await shipbay('POST', '/v1/pallets/assign', { pallet: 'SYN-B-1', to: 'P-99' })).status], ['location_not_found', 404]);
  assert.equal((await shipbay('POST', '/v1/pallets/move', { pallet: 'SYN-S-1', to: 'P-38' })).status, 404, 'ShipBay cannot move a Souled pallet');
  const mv = await souled('POST', '/v1/pallets/move', { pallet: 'SYN-S-1', to: 'P-38', from: 'P-37' }, 'mv-1'); const again = await souled('POST', '/v1/pallets/move', { pallet: 'SYN-S-1', to: 'P-38', from: 'P-37' }, 'mv-1');
  assert.deepEqual([mv.ok, again.replayed, again.seq], [true, true, mv.seq]);
  assert.equal((await souled('POST', '/v1/pallets/move', { pallet: 'SYN-S-1', to: 'P-39', from: 'P-37' })).error, 'pallet_elsewhere', 'a stale request is refused');
  const noKey = await fetch(svc.url + '/v1/pallets/move', { method: 'POST', headers: { authorization: `Bearer ${keys.souled}` }, body: JSON.stringify({ pallet: 'SYN-S-1', to: 'P-40' }) }); assert.equal(noKey.status, 400, 'no Idempotency-Key, no move');
  const race = await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? souled : shipbay)('POST', '/v1/pallets/assign', { pallet: `SYN-R-${i}`, to: 'P-01' })));
  assert.deepEqual([race.filter((r) => r.ok).length, race.filter((r) => r.status === 409).length], [1, 15]);
  for (const stg of ['STG-01', 'STG-02']) assert.equal((await shipbay('POST', '/v1/pallets/assign', { pallet: `SYN-${stg}`, to: stg })).ok, true);
  assert.equal((await souled('POST', '/v1/pallets/release', { pallet: 'SYN-S-1', from: 'P-38' })).released_from, 'P-38');
  assert.equal((await shipbay('GET', '/v1/occupancy')).locations.find((l) => l.code === 'P-38').used, 0);
});
test('calendar: each system files its own events, both see both, private fields stay with the owner', async () => {
  const e = { direction: 'inbound', starts_at: '2026-12-01T10:00:00-05:00', ends_at: '2026-12-01T11:00:00-05:00', pallets: 6, reference: 'SYN-BOL-1', note: 'synthetic' };
  const made = await souled('PUT', '/v1/calendar/SW-EV-1', e); assert.deepEqual([made.created, made.changed], [true, true]);
  assert.equal((await souled('PUT', '/v1/calendar/SW-EV-1', e)).changed, false, 'sending it again changes nothing');
  await shipbay('PUT', '/v1/calendar/SB-EV-1', { direction: 'outbound', starts_at: '2026-12-01T14:00:00-05:00', pallets: 3, reference: 'SYN-PO-9' });
  const range = '?from=2026-12-01T00:00:00-05:00&to=2026-12-02T00:00:00-05:00'.replace(/\+/g, '%2B');
  const s = (await souled('GET', '/v1/calendar' + range)).events, b = (await shipbay('GET', '/v1/calendar' + range)).events;
  assert.deepEqual(s.map((x) => [x.company, x.direction, x.pallets, x.status]), b.map((x) => [x.company, x.direction, x.pallets, x.status]), 'both systems hold the same calendar');
  assert.deepEqual(b.find((x) => x.company === 'SOULED'), { company: 'SOULED', direction: 'inbound', starts_at: s[0].starts_at, ends_at: s[0].ends_at, pallets: 6, status: 'scheduled', updated_at: s[0].updated_at, mine: false });
  assert.equal(s.find((x) => x.mine).reference, 'SYN-BOL-1');
  assert.equal((await shipbay('PUT', '/v1/calendar/SW-EV-1', { status: 'cancelled' })).status, 400, 'ShipBay cannot touch Souled\'s event: for ShipBay that id is a new event with nothing in it');
  await souled('PUT', '/v1/calendar/SW-EV-1', { starts_at: '2026-12-01T12:00:00-05:00', ends_at: '2026-12-01T13:00:00-05:00' });
  assert.equal(new Date((await shipbay('GET', '/v1/calendar' + range)).events.find((x) => x.company === 'SOULED').starts_at).toISOString(), '2026-12-01T17:00:00.000Z', 'a reschedule reaches the other side');
  assert.equal((await souled('DELETE', '/v1/calendar/SW-EV-1')).status, 200); assert.equal((await shipbay('GET', '/v1/calendar' + range)).events.find((x) => x.company === 'SOULED').status, 'cancelled');
  assert.equal((await souled('PUT', '/v1/calendar/SW-EV-2', { direction: 'sideways', starts_at: 'tomorrow-ish' })).status, 400);
  assert.equal((await souledLive('PUT', '/v1/calendar/SW-LIVE-1', e)).ok, true, 'the calendar is not occupancy: it works on the live floor before the baseline');
});
test('outage: a system that was away catches up from the feed; Nexus down means nothing half-done and a safe retry', async () => {
  const before = (await shipbay('GET', '/v1/changes?after=0&limit=1000')).last;
  await souled('POST', '/v1/pallets/assign', { pallet: 'SYN-S-2', to: 'P-55' }); await souled('PUT', '/v1/calendar/SW-EV-3', { direction: 'outbound', starts_at: '2026-12-03T09:00:00-05:00' });
  const missed = await shipbay('GET', `/v1/changes?after=${before}`); assert.deepEqual(missed.changes.map((c) => [c.kind, c.company, c.location ?? null]), [['pallet_assigned', 'SOULED', 'P-55'], ['calendar_added', 'SOULED', null]]);
  assert.ok(missed.changes.every((c) => !('pallet' in c) && !('event' in c)), 'the other company\'s pallet and event ids are not in ShipBay\'s feed');
  const url = svc.url; await svc.close();
  await assert.rejects(fetch(url + '/v1/pallets/move', { method: 'POST', headers: { authorization: `Bearer ${keys.souled}`, 'idempotency-key': 'out-1' }, body: JSON.stringify({ pallet: 'SYN-S-2', to: 'P-56' }) }), 'Nexus is unreachable: the caller gets a failure, not a guess');
  svc = await serve(`${base}/nexusservice`);
  assert.equal((await souled('GET', '/v1/occupancy')).locations.find((l) => l.code === 'P-55').your_pallets[0], 'SYN-S-2', 'the pallet is still where it was');
  const retry = await souled('POST', '/v1/pallets/move', { pallet: 'SYN-S-2', to: 'P-56' }, 'out-1'), dup = await souled('POST', '/v1/pallets/move', { pallet: 'SYN-S-2', to: 'P-56' }, 'out-1');
  assert.deepEqual([retry.ok, dup.replayed], [true, true], 'the retry with the same key lands once');
  const broken = (await import('../service/handler.mjs')).makeHandler(async () => { throw new Error('connection to database at 10.0.0.5 refused'); });
  const r = await broken(new Request('http://x/v1/occupancy', { headers: { authorization: 'Bearer k' } })); const t = await r.text(); assert.equal(r.status, 503); assert.ok(!/10\.0\.0\.5|refused/.test(t), 'a database failure is not leaked to the caller');
});
