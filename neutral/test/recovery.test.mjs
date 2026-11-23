// Backup, restore and recovery, end to end, on throwaway local databases with synthetic data only:
//   node --test neutral/test/recovery.test.mjs
// The "source" here is a local database built from the migrations. No hosted system is read or written.
import test from 'node:test'; import assert from 'node:assert/strict'; import pg from 'pg'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { spawn } from 'node:child_process';
import { validate, POSITIONS } from '../baseline/validate.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)); const server = 'postgres://postgres@127.0.0.1:54318'; const SRC = `${server}/nexusrecovery`; const ops = path.join(here, '..', 'ops');
const admin = new pg.Client(`${server}/postgres`); await admin.connect();
for (const d of ['nexusrecovery', 'nexus_restore_test_creds']) await admin.query(`drop database if exists ${d}`); await admin.query('create database nexusrecovery');
const pool = new pg.Pool({ connectionString: SRC });
for (const f of ['001_core.sql', '002_floor_map.sql', '003_calendar.sql', '004_baseline.sql', '005_key_handoff.sql']) await pool.query(fs.readFileSync(path.join(here, '..', f), 'utf8'));
const on = (p) => ({ q: async (sql, a) => (await p.query(sql, a)).rows, one: async (sql, a) => Object.values((await p.query(sql, a)).rows[0])[0] });
const { q, one } = on(pool); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-bk-'));
test.after(async () => { await pool.end(); for (const d of ['nexus_restore_test_creds']) await admin.query(`drop database if exists ${d}`); await admin.end(); fs.rmSync(tmp, { recursive: true, force: true }); });
const run = (script, args, env = {}) => new Promise((done) => { const c = spawn(path.join(ops, script), args, { env: { ...process.env, ...env } }); let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d)); c.on('close', (code) => done({ code, out })); });

// ───── a synthetic Nexus with everything a backup must carry ─────
const WH = 'HILLSBOROUGH', TF = 'HILLSBOROUGH-TEST', T = '2026-12-05T09:00:00-05:00';
await q(`insert into nexus.companies (code, name) values ('SOULED', 'Souled Worldwide'), ('SHIPBAY', 'ShipBay3PL')`);
const SOULED = await one(`select id from nexus.companies where code = 'SOULED'`), SHIPBAY = await one(`select id from nexus.companies where code = 'SHIPBAY'`);
const mkOp = (c, n, r) => one(`select nexus.operator_create('test', $1, $2, $3)`, [c, n, r]); const mkKey = (c, s, w, sc) => one(`select nexus.integration_create('test', $1, $2, $3, $4)`, [c, s, w, sc]);
const owner = await mkOp(null, 'Owner', ['initialize', 'unlock', 'stop', 'registry', 'view']), sRep = await mkOp('SOULED', 'Souled Approver', ['approve_baseline', 'stop']), bRep = await mkOp('SHIPBAY', 'ShipBay Approver', ['approve_baseline', 'stop']);
const kSouledLive = await mkKey(SOULED, 'souled-wms', WH, ['read', 'move', 'calendar']), kShipLive = await mkKey(SHIPBAY, 'shipbay-wms', WH, ['read', 'move']), kShipTest = await mkKey(SHIPBAY, 'shipbay-dev', TF, ['read', 'move']), kSouledTest = await mkKey(SOULED, 'souled-dev', TF, ['read', 'move']);
const api = (db) => ({ place: (k, kind, pallet, to, from, idem) => db.one(`select nexus.api_place($1, $2, $3, $4, $5, $6)`, [k, kind, pallet, to, from, idem]), call: (fn, ...a) => db.one(`select nexus.${fn}(${a.map((_, i) => `$${i + 1}`).join(', ')})`, a),
  occ: async (wh) => (await db.q(`select c.code || ' ' || p.external_id || ' @ ' || l.code x from nexus.occupancy o join nexus.pallets p on p.id = o.pallet_id join nexus.companies c on c.id = p.company_id join nexus.locations l on l.id = o.location_id where l.warehouse = $1 order by 1`, [wh])).map((r) => r.x) });
const S = api({ q, one });
// test floor: an assign, a move, a refusal (ShipBay's standing pallet, a Souled pallet turned away from it)
await S.place(kShipTest, 'assign', 'PSKU-000001', 'P-01', null, 't-1'); await S.place(kSouledTest, 'assign', 'SYN-S-1', 'P-01', null, 't-2'); await S.place(kSouledTest, 'assign', 'SYN-S-1', 'P-02', null, 't-3'); await S.place(kSouledTest, 'move', 'SYN-S-1', 'P-03', 'P-02', 't-4');
// real-shaped floor: capacities, counted baseline, both approvals, initialized, both gos, unlocked, then live moves and a refusal
for (const p of POSITIONS) await S.call('location_capacity_verify', owner, WH, p.code, 1, 'synthetic spec');
const FLOOR = { 'P-05': ['SOULED', 'SW-1'], 'P-06': ['SOULED', 'SW-2'], 'P-40': ['SHIPBAY', 'SB-1'] };
const sheet = (who) => POSITIONS.map((p) => (FLOOR[p.code] ? { position: p.code, state: 'OCCUPIED', company: FLOOR[p.code][0], pallet_id: FLOOR[p.code][1], counted_by: who, counted_at: T } : { position: p.code, state: 'EMPTY', counted_by: who, counted_at: T }));
const report = validate({ count: sheet('Counter A'), second: sheet('Counter B'), mapVersion: await one(`select map_version from nexus.warehouses where code = $1`, [WH]), mapChecksum: await one(`select nexus._map_checksum($1)`, [WH]) });
const baseline = (await S.call('baseline_submit', owner, WH, report)).baseline;
await S.call('baseline_approve', sRep, baseline, report.baseline_fingerprint); await S.call('baseline_approve', bRep, baseline, report.baseline_fingerprint);
assert.equal((await S.call('baseline_initialize', owner, baseline, report.baseline_fingerprint, 'synthetic-backup-0')).ok, true);
await S.call('floor_unlock_approve', sRep, WH); await S.call('floor_unlock_approve', bRep, WH); assert.equal((await S.call('floor_unlock', owner, WH, `UNLOCK ${WH}`)).moves_enabled, true);
await S.place(kSouledLive, 'move', 'SW-1', 'P-07', 'P-05', 'l-1'); await S.place(kShipLive, 'assign', 'SB-2', 'P-41', null, 'l-2'); await S.place(kShipLive, 'move', 'SB-2', 'P-07', 'P-41', 'l-3'); await S.place(kSouledLive, 'release', 'SW-2', null, 'P-06', 'l-4');
await one(`select nexus.api_calendar_put($1, 'EV-1', $2)`, [kSouledLive, { direction: 'inbound', starts_at: '2026-12-10T10:00:00-05:00', pallets: 4, reference: 'SYN-REF' }]);
await S.call('discrepancy_open', sRep, WH, 'P-09', 'label', 'synthetic open discrepancy');
const PLAINTEXT = 'nxk_' + 'ab12'.repeat(16); await q(`insert into nexus.key_handoff (label, env_name, key) values ('pending pickup', 'NEXUS_STAGING_API_KEY', $1)`, [PLAINTEXT]);
const hashes = (await q(`select key_hash h from nexus.integrations union all select token_hash from nexus.operators`)).map((r) => r.h);
const bytes = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => fs.readFileSync(path.join(dir, f)).toString('latin1')).join('\n');
const digestNow = () => one(`select nexus.snapshot_digest() ->> '_all'`);

test('rehearsal backup: complete, carries no key, no hash and no pickup row; restoring it verifies and locks', async () => {
  const before = await digestNow(); const dir = path.join(tmp, 'redacted');
  const b = await run('backup.sh', [SRC, dir]); assert.equal(b.code, 0, b.out); assert.match(b.out, /15 tables, mode redacted/);
  assert.equal(await digestNow(), before, 'taking a backup changed nothing in the source');
  const m = fs.readFileSync(path.join(dir, 'manifest.txt'), 'utf8'); assert.match(m, /unlocked_real_floors=HILLSBOROUGH/);
  for (const t of ['warehouses', 'locations', 'occupancy', 'pallets', 'moves', 'change_log', 'calendar_events', 'baselines', 'baseline_approvals', 'unlock_approvals', 'discrepancies', 'audit_log', 'companies', 'integrations', 'operators']) assert.match(m, new RegExp(`^table=${t}\\|[1-9]`, 'm'), `${t} is in the backup with rows`);
  assert.ok(!/table=key_handoff/.test(m));
  const text = bytes(dir) + (await new Promise((done) => { const c = spawn('pg_restore', ['--data-only', '--file=-', path.join(dir, 'nexus.dump')]); let o = ''; c.stdout.on('data', (d) => (o += d)); c.on('close', () => done(o)); }));
  assert.ok(!text.includes(PLAINTEXT) && !text.includes('pending pickup'), 'the pickup row is not in the backup'); for (const h of hashes) assert.ok(!text.includes(h), 'no credential hash is in the backup');
  for (const k of [kSouledLive, kShipLive, kShipTest, owner, sRep]) assert.ok(!text.includes(k));
  assert.ok(text.includes('l-3') && text.includes('SYN-REF') && text.includes(report.baseline_fingerprint), 'idempotency records, calendar and the approved baseline are in it');
  const r = await run('restore-verify.sh', [dir, server]); assert.equal(r.code, 0, r.out); assert.match(r.out, /all 15 tables match row for row/); assert.match(r.out, /RESTORE VERIFIED AND LOCKED/); assert.ok(!/FAIL/.test(r.out), r.out);
  assert.match(r.out, /taken while these real floors were open: HILLSBOROUGH/); assert.match(r.out, /no usable integration key or operator token/); assert.match(r.out, /8 sent again, 0 acted again, 0 slipped past a lock, changed=false/);
  assert.equal((await run('backup.sh', [SRC, dir])).code, 2, 'an existing backup is never overwritten');
});
test('an interrupted or altered restore is caught and never passed as good', async () => {
  const dir = path.join(tmp, 'redacted');
  const cut = await run('restore-verify.sh', [dir, server], { SIMULATE_INTERRUPTED_RESTORE: '1' }); assert.equal(cut.code, 1); assert.match(cut.out, /RESTORE NOT VERIFIED\. Do not use this database\. Drop it and restore again/); assert.ok(!/3\. lock/.test(cut.out));
  const bad = path.join(tmp, 'altered'); fs.cpSync(dir, bad, { recursive: true }); fs.writeFileSync(path.join(bad, 'manifest.txt'), fs.readFileSync(path.join(bad, 'manifest.txt'), 'utf8').replace(/^(table=occupancy\|\d+\|)./m, '$1z'));
  const alt = await run('restore-verify.sh', [bad, server]); assert.equal(alt.code, 1); assert.match(alt.out, /tables differ: occupancy/);
  const into = await run('restore-verify.sh', [dir, server, 'nexusrecovery']); assert.equal(into.code, 2); assert.match(into.out, /refusing to restore into an existing database/);
  assert.equal(await one(`select count(*)::int from pg_database where datname like 'nexus_restore_2%'`), 0, 'failed attempts leave no half-restored database behind');
});
test('disaster recovery: a move in flight during the backup, a floor that was open, and no duplicate placement afterwards', async () => {
  // a move that has started but not finished when the backup is taken, and one that completes just after it
  const inflight = await pool.connect(); await inflight.query('begin'); const started = (await inflight.query(`select nexus.api_place($1, 'move', 'SW-1', 'P-20', 'P-07', 'in-flight-1') r`, [kSouledLive])).rows[0].r; assert.equal(started.ok, true);
  const dir = path.join(tmp, 'creds'); const b = await run('backup.sh', [SRC, dir, '--with-credentials']); assert.equal(b.code, 0, b.out);
  await inflight.query('commit'); inflight.release(); const cursorHeldByWms = await one(`select max(seq) from nexus.change_log`);
  assert.equal((await S.place(kShipLive, 'assign', 'SB-3', 'P-50', null, 'after-backup-1')).ok, true);
  assert.deepEqual(await S.occ(WH), ['SHIPBAY SB-1 @ P-40', 'SHIPBAY SB-2 @ P-41', 'SHIPBAY SB-3 @ P-50', 'SOULED SW-1 @ P-20']);
  const r = await run('restore-verify.sh', [dir, server, 'nexus_restore_test_creds'], { KEEP: '1' }); assert.equal(r.code, 0, r.out); assert.match(r.out, /credentials are the ones that were backed up/);
  const rp = new pg.Pool({ connectionString: `${server}/nexus_restore_test_creds` }); const R = api(on(rp)); const rdb = on(rp);
  try {
    // the copy is the floor as it stood at the backup: the unfinished move and the later one are not in it
    assert.deepEqual(await R.occ(WH), ['SHIPBAY SB-1 @ P-40', 'SHIPBAY SB-2 @ P-41', 'SOULED SW-1 @ P-07'], 'a consistent instant: nothing half-moved');
    assert.equal(await rdb.one(`select count(*)::int from nexus.moves where idempotency_key in ('in-flight-1', 'after-backup-1')`), 0); assert.deepEqual(await R.occ(TF), ['SHIPBAY PSKU-000001 @ P-01', 'SOULED SYN-S-1 @ P-03']);
    // locked, although the source was open when the backup was taken
    assert.deepEqual((await rdb.q(`select occupancy_state s, moves_enabled m from nexus.warehouses where code = $1`, [WH]))[0], { s: 'verified', m: false });
    assert.equal((await R.place(kSouledLive, 'move', 'SW-1', 'P-20', 'P-07', 'in-flight-1')).error, 'occupancy_not_initialized', 'a working key cannot move anything on the restored floor');
    await assert.rejects(rp.query(`update nexus.warehouses set moves_enabled = true where code = 'HILLSBOROUGH-X'`).then((x) => { if (!x.rowCount) throw new Error('no such floor'); }));
    const refused = await R.call('floor_unlock', owner, WH, `UNLOCK ${WH}`); assert.deepEqual([refused.error, refused.still_needed_from], ['open_discrepancies', undefined], 'the open discrepancy came back too and still blocks');
    const d = await rdb.one(`select id from nexus.discrepancies where resolved_at is null`); await R.call('discrepancy_resolve', bRep, d, 'checked after recovery');
    assert.deepEqual((await R.call('floor_unlock', owner, WH, `UNLOCK ${WH}`)).still_needed_from, ['SHIPBAY', 'SOULED'], 'the gos given before the backup do not count');
    // a system that held its place in the feed is told about the restore and misses nothing
    const feed = await rdb.one(`select nexus.api_changes($1, $2)`, [kShipLive, cursorHeldByWms]); assert.deepEqual(feed.changes.map((c) => c.kind), ['nexus_restored'], 'new entries are numbered above any number a system could be holding');
    // administrators resume: both companies give a fresh go
    await R.call('floor_unlock_approve', sRep, WH); await R.call('floor_unlock_approve', bRep, WH); assert.equal((await R.call('floor_unlock', owner, WH, `UNLOCK ${WH}`)).moves_enabled, true);
    // every movement request recorded before the backup, sent again exactly as first sent: nothing moves
    const before = await R.occ(WH); const rows = await rdb.q(`select m.requester, m.warehouse, m.company_id, m.kind, m.external_id, m.request, m.idempotency_key, m.result from nexus.moves m order by m.id`);
    assert.equal(rows.length, 8);
    for (const m of rows) { const again = await rdb.one(`select nexus.place($1, $2, $3, 'retry', $4, $5, $6, $7, $8)`, [m.requester, m.warehouse, m.company_id, m.kind, m.external_id, m.request.to ?? null, m.request.from ?? null, m.idempotency_key]); assert.equal(again.replayed, true, m.idempotency_key); assert.equal(again.ok ? 'ok' : again.error, m.result); }
    assert.deepEqual(await R.occ(WH), before); assert.equal(await rdb.one(`select count(*)::int from nexus.moves`), 8, 'no duplicate placement and no new history row');
    // the two requests the backup never saw are retried by their systems with their original keys: each happens exactly once
    const a1 = await R.place(kSouledLive, 'move', 'SW-1', 'P-20', 'P-07', 'in-flight-1'), a2 = await R.place(kSouledLive, 'move', 'SW-1', 'P-20', 'P-07', 'in-flight-1'); assert.deepEqual([a1.ok, a1.replayed ?? false, a2.replayed], [true, false, true]);
    const b1 = await R.place(kShipLive, 'assign', 'SB-3', 'P-50', null, 'after-backup-1'), b2 = await R.place(kShipLive, 'assign', 'SB-3', 'P-50', null, 'after-backup-1'); assert.deepEqual([b1.ok, b2.replayed], [true, true]);
    assert.deepEqual(await R.occ(WH), await S.occ(WH), 'after the retries the restored floor equals the lost one');
    assert.equal(await rdb.one(`select count(*)::int from (select pallet_id from nexus.occupancy group by 1 having count(*) > 1) x`), 0);
    assert.ok(await rdb.one(`select (select min(id) from nexus.moves where idempotency_key in ('in-flight-1', 'after-backup-1')) > (select max(id) from nexus.moves where idempotency_key like 'l-%')`), 'new history rows are numbered after the restored ones');
  } finally { await rp.end(); }
});
