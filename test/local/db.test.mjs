// The v2 candidate on the local synthetic database: run `./load.sh && node --test db.test.mjs`. Refuses any host but 127.0.0.1.
import test from 'node:test'; import assert from 'node:assert/strict'; import pg from 'pg';
const db = new pg.Client('postgres://postgres@127.0.0.1:54318/nexuslocal'); await db.connect();
const ADMIN = 'aa000000-0000-4000-8000-000000000002', FLOOR = 'aa000000-0000-4000-8000-000000000001', A = 'bb000000-0000-4000-8000-00000000000a', B = 'bb000000-0000-4000-8000-00000000000b';
const as = async (role, sub, sql, p = []) => { await db.query('begin'); try { await db.query(`set local role ${role}`); await db.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify(sub ? { sub } : {})]); const r = await db.query(sql, p); await db.query('commit'); return r.rows; } catch (e) { await db.query('rollback'); throw e; } };
const admin = (s, p) => as('authenticated', ADMIN, s, p), floor = (s, p) => as('authenticated', FLOOR, s, p), anon = (s, p) => as('anon', null, s, p);
const one = async (f, s, p) => Object.values((await f(s, p))[0])[0];
const pal = async (where) => (await db.query(`select * from (select p.*, l.code loc from wms_pallets p left join locations l on l.id = p.location_id) q where ${where} order by psku limit 1`)).rows[0];
test.after(() => db.end());

test('label register: every pallet and carton made by a WMS is in Nexus', async () => {
  const n = (await db.query(`select (select count(*) from wms_pallets) p, (select count(*) from wms_cartons) c, (select count(*) from nexus_labels where kind='pallet') lp, (select count(*) from nexus_labels where kind='carton') lc`)).rows[0];
  assert.equal(n.p, n.lp); assert.equal(n.c, n.lc);
  const p = await pal(`status = 'stored'`); await db.query('update wms_pallets set label_prints = label_prints + 1, last_printed_at = now() where id = $1', [p.id]);
  assert.equal((await db.query(`select prints from nexus_labels where kind='pallet' and code=$1`, [p.psku])).rows[0].prints, p.label_prints + 1);
  const list = await one(admin, `select nexus_labels_list(null, 'pallet', $1)`, [p.psku]); assert.equal(list.length, 1); assert.equal(list[0].content.psku, p.psku);
  assert.equal(await one(admin, `select nexus_labels_printed('position', array['P-01','P-02'])`), 2);
  await assert.rejects(anon(`select nexus_labels_list()`), /permission denied/);
});
test('move: stored pallet to a free position, stock follows, logged; taken position refused', async () => {
  const p = await pal(`status = 'stored' and org_id = '${A}'`); const other = await pal(`status = 'stored' and id <> '${p.id}'`);
  await assert.rejects(admin(`select nexus_move_pallet($1, $2)`, [p.psku, other.loc]), /already holds a pallet/);
  await assert.rejects(floor(`select nexus_move_pallet($1, 'P-30')`, [p.psku]), /admin or staff/);
  const r = await one(admin, `select nexus_move_pallet($1, 'LOC-P-30', 'Making room by the dock')`, [p.psku]); assert.deepEqual([r.from, r.to], [p.loc, 'P-30']);
  const m = (await db.query(`select l.code from inventory_moves m join locations l on l.id = m.location_id where m.ref_id = $1`, [p.id])).rows; assert.deepEqual(m, [{ code: 'P-30' }]);
  const d = await one(admin, `select nexus_pallet_detail($1)`, [p.psku]); assert.equal(d.position, 'P-30'); assert.equal(d.history[0].action, 'move'); assert.equal(d.history[0].reason, 'Making room by the dock');
  const pos = await one(admin, `select nexus_position_detail('P-30')`); assert.equal(pos.pallets[0].psku, p.psku); assert.equal(pos.pallets[0].reference, 'VOL-135'); assert.ok(pos.pallets[0].carton_labels > 0);
});
test('put away from Nexus: waiting pallet stored; held pallet refused', async () => {
  const w = await pal(`status <> 'stored' and not held`); const h = await pal(`held`);
  const r = await one(admin, `select nexus_move_pallet($1, 'P-31', null, true)`, [w.psku]); assert.equal(r.stored, true);
  assert.equal((await pal(`id = '${w.id}'`)).status, 'stored');
  await assert.rejects(admin(`select nexus_move_pallet($1, 'P-32', null, true)`, [h.psku]), /on HOLD/);
});
test('override: admin only, reason needed, old and new values logged', async () => {
  const p = await pal(`status = 'stored' and org_id = '${B}'`);
  await assert.rejects(floor(`select nexus_pallet_edit($1, '{"cartons": 9}', 'x')`, [p.psku]), /Only a Nexus admin/);
  await assert.rejects(admin(`select nexus_pallet_edit($1, '{"cartons": 9}', '')`, [p.psku]), /Say why/);
  await assert.rejects(admin(`select nexus_pallet_edit($1, '{"status": "open"}', 'x')`, [p.psku]), /cannot be changed/);
  const log = await one(admin, `select nexus_pallet_edit($1, $2, 'Recount on the floor')`, [p.psku, JSON.stringify({ cartons: 9, units_total: 54, notes: 'Top layer short' })]);
  assert.deepEqual(log.cartons, { from: p.cartons, to: 9 }); assert.equal((await pal(`id = '${p.id}'`)).units_total, 54);
  await admin(`select nexus_pallet_void($1, 'Entered twice')`, [p.psku]); assert.equal((await pal(`id = '${p.id}'`)).status, 'void');
  const fl = await one(admin, `select nexus_floor_log(50)`); assert.ok(fl.some((x) => x.action === 'void' && x.psku === p.psku)); assert.ok(fl.some((x) => x.action === 'pallet_putaway'));
});
test('positions: zone change and off/on; a position with a pallet cannot be turned off', async () => {
  const p = await pal(`status = 'stored'`);
  await assert.rejects(admin(`select nexus_position_edit($1, 'bulk', false)`, [p.loc]), /Move the pallet off/);
  await admin(`select nexus_position_edit('P-72', 'overflow', false)`); assert.deepEqual(await one(admin, `select nexus_positions_off()`), [{ code: 'P-72', zone: 'overflow' }]);
  await admin(`select nexus_position_edit('P-72', 'outbound', true)`);
});
test('connections: two keys, permissions, and what each window can do', async () => {
  const made = await one(admin, `select nexus_connection_save(null, 'Sample Sneakers WMS', $1, null)`, [[B]]); assert.match(made.floor_key, /^nxs_[0-9a-f]{64}$/); assert.notEqual(made.floor_key, made.admin_key);
  const w = await one(anon, `select nexus_api_window($1)`, [made.floor_key]); assert.equal(w.access, 'floor'); assert.equal((await one(anon, `select nexus_api_window($1)`, [made.admin_key])).access, 'admin');
  const f = await one(anon, `select nexus_api_floor($1)`, [made.floor_key]);
  assert.ok(f.positions.filter((x) => x.taken).length > f.positions.filter((x) => x.pallets.length).length, 'other brands show as taken, with no detail');
  assert.ok(f.positions.every((x) => x.pallets.every((y) => y.brand === 'Sample Sneakers')));
  await assert.rejects(anon(`select nexus_api_shipments($1, current_date - 30, current_date + 30)`, [made.floor_key]), /cannot see the shipment calendar/);
  const cal = await one(anon, `select nexus_api_shipments($1, current_date - 30, current_date + 30)`, [made.admin_key]); assert.ok(cal.length >= 2 && cal.every((x) => x.brand === 'Sample Sneakers'));
  const id = await one(anon, `select nexus_api_shipment_save($1, $2)`, [made.admin_key, JSON.stringify({ org_id: B, reference: 'Spring drop', expected_at: '2026-12-10', pallets: 3 })]);
  assert.equal((await db.query('select approved_at from inbound_shipments where id=$1', [id])).rows[0].approved_at, null, 'a booking from a window waits for Nexus to confirm');
  await assert.rejects(anon(`select nexus_api_shipment_save($1, $2)`, [made.admin_key, JSON.stringify({ org_id: A, reference: 'x', expected_at: '2026-12-10', pallets: 3 })]), /this connection's brands/);
  const mine = await pal(`status = 'stored' and org_id = '${B}'`), theirs = await pal(`status = 'stored' and org_id = '${A}'`);
  const s = await one(anon, `select nexus_api_scan($1, $2, 'P-33')`, [made.floor_key, mine.psku]); assert.equal(s.to, 'P-33');
  await assert.rejects(anon(`select nexus_api_scan($1, $2, 'P-34')`, [made.floor_key, theirs.psku]), /not on file for this connection/);
  await admin(`select nexus_connection_save($1, 'Sample Sneakers WMS', $2, $3)`, [made.id, [B], JSON.stringify({ floor: { scan: false }, admin: { labels: false } })]);
  await assert.rejects(anon(`select nexus_api_scan($1, $2, 'P-35')`, [made.floor_key, mine.psku]), /cannot scan/);
  await assert.rejects(anon(`select nexus_api_labels($1)`, [made.admin_key]), /cannot see labels/);
  assert.equal((await one(anon, `select nexus_api_counts($1)`, [made.admin_key])).brands.length, 1, 'the read API takes either key');
  const k2 = await one(admin, `select nexus_connection_new_key($1, 'floor')`, [made.id]); await assert.rejects(anon(`select nexus_api_window($1)`, [made.floor_key]), /Unknown or inactive/); assert.equal((await one(anon, `select nexus_api_window($1)`, [k2])).access, 'floor');
  await admin(`select nexus_client_set_active($1, false)`, [made.id]); await assert.rejects(anon(`select nexus_api_floor($1)`, [k2]), /Unknown or inactive/);
  await assert.rejects(floor(`select nexus_connections_list()`), /Only a Nexus admin/);
});
test('calendar: change and cancel; dashboard reads', async () => {
  const i = (await db.query(`select id from inbound_shipments where reference = 'Holiday candles'`)).rows[0].id;
  await admin(`select nexus_shipment_update($1, current_date + 12, 4, 96, null, 'Lift gate needed', false)`, [i]);
  const r = (await db.query('select pallets, approved_at from inbound_shipments where id=$1', [i])).rows[0]; assert.equal(r.pallets, 4); assert.ok(r.approved_at);
  await admin(`select nexus_shipment_update($1, null, null, null, null, null, true)`, [i]);
  const d = await one(floor, `select nexus_dashboard()`); assert.ok(d.labels_total > 100 && Array.isArray(d.waiting) && d.log.length > 0);
});
test('receiving in Nexus: receive against the booking, put away, complete; the booking is marked for the WMS', async () => {
  const i = (await db.query(`select id, org_id from inbound_shipments where reference = 'VOL-136 records'`)).rows[0]; const sku = (await db.query(`select id from skus where sku = 'REC-LP-135'`)).rows[0].id;
  const br = await one(floor, `select nexus_receiving_brands()`); assert.ok(br.find((b) => b.name === 'Sample Records').open >= 2);
  const made = await floor(`select * from wms_receive_booking($1, $2, $3, 6, null, 'k-test-1', 'final', null)`, [i.id, i.org_id, JSON.stringify([{ sku, cartons: 20, units_per_carton: 20 }])]); assert.equal(made.length, 6);
  await assert.rejects(floor(`select nexus_receiving_finish($1)`, [i.id]), /has to be put away first/);
  for (const [n, p] of made.entries()) await floor(`select nexus_putaway($1, $2)`, [p.psku, `P-${45 + n}`]);
  const r = await one(floor, `select nexus_receiving_finish($1)`, [i.id]); assert.equal(r.status, 'discrepancy', '6 of 6 pallets but 120 of 175 cartons booked');
  const b = (await db.query('select status, received_at from inbound_shipments where id = $1', [i.id])).rows[0]; assert.equal(b.status, 'discrepancy'); assert.ok(b.received_at);
  await assert.rejects(floor(`select nexus_receiving_finish($1)`, [i.id]), /already discrepancy/);
  const list = await one(floor, `select nexus_receiving($1)`, [i.org_id]); assert.equal(list.find((x) => x.id === i.id).pallet_list.length, 6);
  assert.equal(await one(floor, `select nexus_labels_printed('pallet', $1)`, [[made[0].psku]]), 1); assert.equal((await db.query(`select prints from nexus_labels where kind = 'pallet' and code = $1`, [made[0].psku])).rows[0].prints, 1);
});
