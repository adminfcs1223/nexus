// The dry-run baseline validator. No database: `node --test neutral/test/baseline.test.mjs`.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { validate, parseCsv, POSITIONS, report } from '../baseline/validate.mjs';
const T = '2026-12-05T09:00:00-05:00';
// a clean floor: Souled at P-01 and P-02, ShipBay at P-31, two ShipBay pallets in STG-01, everything else empty
const floor = (who, edit = (rows) => rows) => edit(POSITIONS.flatMap((p) => {
  const full = { 'P-01': [['SOULED', 'SW-1001']], 'P-02': [['SOULED', 'SW-1002']], 'P-31': [['SHIPBAY', 'PSKU-000101']], 'STG-01': [['SHIPBAY', 'PSKU-000102'], ['SHIPBAY', 'PSKU-000103']] }[p.code];
  return full ? full.map(([company, pallet_id]) => ({ position: p.code, state: 'OCCUPIED', company, pallet_id, counted_by: who, counted_at: T })) : [{ position: p.code, state: 'EMPTY', company: '', pallet_id: '', counted_by: who, counted_at: T }];
}));
const codes = (r, level) => r.findings.filter((x) => !level || x.level === level).map((x) => x.code).sort();
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'baseline', 'validate.mjs'), 'utf8');

test('the tool cannot write: it imports no database or network module and says so in every result', () => {
  assert.deepEqual([...src.matchAll(/import [^;]*? from '([^']+)'/g)].map((m) => m[1]).sort(), ['node:crypto', 'node:fs', 'node:url']);
  assert.ok(!/fetch\(|https?:\/\/|\bpg\b|supabase/i.test(src.replace(/\/\/.*$/gm, '')));
  const r = validate({ count: floor('Ana'), second: floor('Ben') }); assert.deepEqual([r.dry_run, r.wrote_anything], [true, false]);
});
test('two agreeing counts of all 68 positions give a fingerprint; any change to the floor changes it', () => {
  const r = validate({ count: floor('Ana'), second: floor('Ben') });
  assert.deepEqual([r.ready_for_joint_approval, r.summary.positions_recorded, r.summary.occupied_positions, r.summary.empty_positions, r.summary.pallets], [true, 68, 4, 64, { SOULED: 2, SHIPBAY: 3 }]);
  assert.match(r.baseline_fingerprint, /^[0-9a-f]{64}$/); assert.equal(r.baseline.length, 68); assert.equal(r.baseline[0], 'P-01=SOULED SW-1001');
  assert.equal(validate({ count: floor('Cy'), second: floor('Di') }).baseline_fingerprint, r.baseline_fingerprint, 'who counted does not change the baseline');
  const moved = (rows) => rows.map((x) => (x.pallet_id === 'SW-1002' ? { ...x, pallet_id: 'SW-1003' } : x));
  assert.notEqual(validate({ count: floor('Ana', moved), second: floor('Ben', moved) }).baseline_fingerprint, r.baseline_fingerprint);
});
test('missing positions, unknown positions and a single count are refused', () => {
  const drop = (rows) => rows.filter((x) => !['P-40', 'STG-02'].includes(x.position)).concat([{ position: 'P-67', state: 'EMPTY', counted_by: 'Ana', counted_at: T }, { position: 'P-72', state: 'OCCUPIED', company: 'SOULED', pallet_id: 'X', counted_by: 'Ana', counted_at: T }]);
  const r = validate({ count: floor('Ana', drop) });
  assert.deepEqual(codes(r, 'error'), ['missing_position', 'missing_position', 'single_count', 'unknown_position', 'unknown_position']);
  assert.deepEqual([r.ready_for_joint_approval, r.baseline_fingerprint, r.baseline], [false, null, null]);
});
test('duplicate pallets, two pallets in one position, unknown owners and half-filled rows are each named', () => {
  const bad = (rows) => rows.map((x) => (x.position === 'P-10' ? { ...x, state: 'OCCUPIED', company: 'SOULED', pallet_id: 'sw-1001' } : x.position === 'P-11' ? { ...x, state: 'OCCUPIED', company: 'ACME', pallet_id: 'A-1' }
    : x.position === 'P-12' ? { ...x, state: 'OCCUPIED', company: '', pallet_id: 'Q-1' } : x.position === 'P-13' ? { ...x, state: 'OCCUPIED', company: 'SHIPBAY', pallet_id: '' } : x.position === 'P-14' ? { ...x, company: 'SOULED' } : x.position === 'P-15' ? { ...x, state: 'maybe' } : x))
    .concat([{ position: 'P-31', state: 'OCCUPIED', company: 'SOULED', pallet_id: 'SW-2000', counted_by: 'Ana', counted_at: T }, { position: 'P-50', state: 'OCCUPIED', company: 'SOULED', pallet_id: 'SW-3000', counted_by: 'Ana', counted_at: T },
      { position: 'P-51', state: 'EMPTY', counted_by: '', counted_at: 'yesterday-ish' }]);
  const r = validate({ count: floor('Ana', bad), second: floor('Ana', bad) }); const e = codes(r, 'error');
  for (const c of ['duplicate_pallet', 'conflicting_placement', 'unknown_owner', 'no_pallet_id', 'empty_with_details', 'bad_state', 'conflicting_rows', 'no_counter', 'no_count_time', 'same_counter']) assert.ok(e.includes(c), c);
  assert.equal(e.filter((c) => c === 'unknown_owner').length, 4, 'ACME and a blank owner, on both sheets');
  assert.match(r.findings.find((x) => x.code === 'duplicate_pallet').message, /P-01 and P-10/); assert.match(r.findings.find((x) => x.code === 'conflicting_placement').message, /P-31 holds one pallet, but 2/);
  assert.ok(codes(r, 'warning').includes('pallet_id_spelling')); assert.equal(r.baseline_fingerprint, null);
});
test('two counts that disagree are sent back to the position', () => {
  const other = (rows) => rows.map((x) => (x.position === 'P-02' ? { ...x, state: 'EMPTY', company: '', pallet_id: '' } : x.position === 'P-03' ? { ...x, state: 'OCCUPIED', company: 'SOULED', pallet_id: 'SW-1002' } : x));
  const r = validate({ count: floor('Ana'), second: floor('Ben', other) });
  assert.deepEqual(r.findings.filter((x) => x.code === 'counts_disagree').map((x) => x.position), ['P-02', 'P-03']); assert.equal(r.ready_for_joint_approval, false);
});
test('each company\'s own records are compared with the count; differences block approval', () => {
  const r = validate({ count: floor('Ana'), second: floor('Ben'), wms: {
    SOULED: [{ pallet_id: 'SW-1001', position: 'P-01' }, { pallet_id: 'SW-1002', position: 'P-05' }, { pallet_id: 'SW-9999', position: 'P-20' }],
    SHIPBAY: [{ pallet_id: 'PSKU-000101', position: 'P-31' }, { pallet_id: 'PSKU-000102', position: '' }] } });
  assert.deepEqual(codes(r, 'discrepancy'), ['in_wms_not_on_floor', 'on_floor_not_in_wms', 'position_differs']); assert.equal(r.ready_for_joint_approval, false);
  const ok = validate({ count: floor('Ana'), second: floor('Ben'), wms: { SOULED: [{ pallet_id: 'SW-1001', position: 'P-01' }, { pallet_id: 'sw-1002', position: 'p-02' }], SHIPBAY: [{ pallet_id: 'PSKU-000101', position: 'P-31' }, { pallet_id: 'PSKU-000102', position: 'STG-01' }, { pallet_id: 'PSKU-000103', position: 'STG-01' }] } });
  assert.equal(ok.ready_for_joint_approval, true);
});
test('known test-floor pallet ids can never enter a real baseline', () => {
  const t = (rows) => rows.map((x) => (x.position === 'P-31' ? { ...x, pallet_id: 'PSKU-000001' } : x));
  const r = validate({ count: floor('Ana', t), second: floor('Ben', t), testIds: ['PSKU-000001', 'CHK-A-1'] });
  assert.ok(codes(r, 'error').includes('test_pallet_id')); assert.equal(r.baseline_fingerprint, null);
});
test('a filled sheet read from CSV behaves the same, quotes and line endings included', () => {
  const csv = (who) => '﻿position,state,company,pallet_id,counted_by,counted_at,note\r\n' + floor(who).map((x) => `${x.position},${x.state},${x.company},${x.pallet_id},"${who}, floor lead",${x.counted_at},"said ""ok"""`).join('\r\n') + '\r\n';
  const r = validate({ count: parseCsv(csv('Ana')), second: parseCsv(csv('Ben')) }); assert.equal(r.ready_for_joint_approval, true);
  assert.equal(r.baseline_fingerprint, validate({ count: floor('Ana'), second: floor('Ben') }).baseline_fingerprint); assert.match(report(r), /READY FOR JOINT APPROVAL/); assert.match(report(r), /DRY RUN/);
});
