// DRY-RUN baseline validator. It reads count sheets (CSV files) and prints a report. It opens no database and no network
// connection, so it cannot write occupancy anywhere. It never reads earlier Nexus, ShipBay or Souled location records:
// the only source of a baseline is what people counted on the floor.
//
//   node neutral/baseline/validate.mjs --count count-A.csv [--second count-B.csv]
//        [--wms SOULED=souled-export.csv] [--wms SHIPBAY=shipbay-export.csv] [--test-ids test-ids.txt] [--json report.json]
//        [--capacity STG-01=2]   only once that capacity has been verified against the physical specification
// Every position holds ONE pallet unless a verified capacity is given: staging spots are not assumed to hold more.
// The --json report of a passing run is the only thing Nexus's baseline import accepts.
//
// Count sheet columns: position, state (EMPTY | OCCUPIED), company, pallet_id, counted_by, counted_at, note
//   one row per position; a staging position holding several pallets gets one row per pallet.
// WMS export columns (what that company's own system believes): pallet_id, position
import fs from 'node:fs'; import crypto from 'node:crypto'; import { fileURLToPath } from 'node:url';

export const MAP_VERSION = 4; export const MAP_CHECKSUM = 'be3cc8f3e9134cb4dfe7d3ac41773bc5d231ed56b4a42c05f5939467d67c8c4f';
export const COMPANIES = ['SOULED', 'SHIPBAY'];
const pad = (n) => `P-${String(n).padStart(2, '0')}`;
export const POSITIONS = [...Array.from({ length: 66 }, (_, i) => ({ code: pad(i + 1), kind: 'pallet', capacity: 1 })), { code: 'STG-01', kind: 'staging', capacity: 1 }, { code: 'STG-02', kind: 'staging', capacity: 1 }];
const KNOWN = new Map(POSITIONS.map((p) => [p.code, p]));

export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false; const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some((x) => x.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).map((r, i) => ({ _line: i + 2, ...Object.fromEntries(head.map((h, j) => [h, (r[j] ?? '').trim()])) }));
}
const norm = (v) => String(v ?? '').trim().toUpperCase();

// One count sheet -> findings + the cleaned rows. `label` names the sheet in messages.
function readCount(rows, label, { testIds = new Set(), capacity = {} } = {}) {
  const cap = (p) => capacity[p.code] ?? p.capacity;
  const f = []; const add = (level, code, position, message, extra = {}) => f.push({ level, code, sheet: label, position: position || null, message, ...extra });
  const byPos = new Map(); const clean = [];
  for (const r of rows) {
    const pos = norm(r.position), state = norm(r.state), company = norm(r.company), pallet = String(r.pallet_id ?? '').trim();
    if (!pos) { add('error', 'row_without_position', null, `Line ${r._line} names no position.`); continue; }
    if (!KNOWN.has(pos)) { add('error', 'unknown_position', pos, `Line ${r._line}: ${pos} is not on the approved map (P-01 to P-66, STG-01, STG-02).`); continue; }
    if (state !== 'EMPTY' && state !== 'OCCUPIED') { add('error', 'bad_state', pos, `Line ${r._line}: state must be EMPTY or OCCUPIED, found "${r.state || ''}".`); continue; }
    if (!r.counted_by) add('error', 'no_counter', pos, `Line ${r._line}: nobody is named as having counted ${pos}.`);
    if (!r.counted_at || Number.isNaN(Date.parse(r.counted_at))) add('error', 'no_count_time', pos, `Line ${r._line}: ${pos} has no readable count time.`);
    if (state === 'EMPTY') {
      if (company || pallet) add('error', 'empty_with_details', pos, `Line ${r._line}: ${pos} is marked EMPTY but carries a company or pallet id.`);
    } else {
      if (!company) add('error', 'unknown_owner', pos, `Line ${r._line}: the pallet at ${pos} has no owning company.`);
      else if (!COMPANIES.includes(company)) add('error', 'unknown_owner', pos, `Line ${r._line}: "${r.company}" at ${pos} is not SOULED or SHIPBAY.`);
      if (!pallet) add('error', 'no_pallet_id', pos, `Line ${r._line}: the pallet at ${pos} has no pallet id. Label it, then record it.`);
      else if (/[\u0000-\u001f\u007f]/.test(pallet)) add('error', 'bad_pallet_id', pos, `Line ${r._line}: the pallet id at ${pos} contains a character that is not plain text.`);
      else if (pallet.length > 64) add('error', 'pallet_id_too_long', pos, `Line ${r._line}: the pallet id at ${pos} is longer than 64 characters.`);
      else if (testIds.has(pallet.toUpperCase())) add('error', 'test_pallet_id', pos, `Line ${r._line}: ${pallet} at ${pos} is a known test-floor id. Test occupancy is never part of the real baseline.`);
    }
    const e = { position: pos, state, company: state === 'OCCUPIED' ? company : '', pallet: state === 'OCCUPIED' ? pallet : '', counted_by: r.counted_by || '', counted_at: r.counted_at || '', line: r._line };
    clean.push(e); if (!byPos.has(pos)) byPos.set(pos, []); byPos.get(pos).push(e);
  }
  for (const p of POSITIONS) {
    const at = byPos.get(p.code) || [];
    if (!at.length) { add('error', 'missing_position', p.code, `${p.code} was not recorded. Every position is recorded, empty ones too.`); continue; }
    const states = new Set(at.map((x) => x.state));
    if (states.size > 1) add('error', 'conflicting_rows', p.code, `${p.code} is recorded both EMPTY and OCCUPIED (lines ${at.map((x) => x.line).join(', ')}).`);
    const full = at.filter((x) => x.state === 'OCCUPIED');
    if (at.filter((x) => x.state === 'EMPTY').length > 1) add('warning', 'repeated_row', p.code, `${p.code} is recorded EMPTY more than once.`);
    if (full.length > cap(p)) add('error', 'conflicting_placement', p.code, `${p.code} holds ${cap(p) === 1 ? 'one pallet' : `${cap(p)} pallets`}${p.kind === 'staging' && capacity[p.code] == null ? ' (staging capacity has not been verified, so one)' : ''}, but ${full.length} are recorded there: ${full.map((x) => `${x.company} ${x.pallet}`).join(' and ')}.`);
  }
  const seen = new Map();   // company + pallet id (case-insensitive) -> positions
  for (const e of clean.filter((x) => x.state === 'OCCUPIED' && x.pallet)) { const k = `${e.company}\u001f${e.pallet.toUpperCase()}`; if (!seen.has(k)) seen.set(k, []); seen.get(k).push(e); }
  for (const [, list] of seen) {
    const spots = [...new Set(list.map((x) => x.position))];
    if (spots.length > 1) add('error', 'duplicate_pallet', spots[0], `${list[0].company} pallet ${list[0].pallet} is recorded at ${spots.join(' and ')}. A pallet stands in one place.`, { positions: spots });
    else if (list.length > 1) add('warning', 'repeated_row', spots[0], `${list[0].company} pallet ${list[0].pallet} is recorded twice at ${spots[0]}.`);
    if (new Set(list.map((x) => x.pallet)).size > 1) add('warning', 'pallet_id_spelling', spots[0], `Pallet id written two ways: ${[...new Set(list.map((x) => x.pallet))].join(' / ')}. Nexus stores ids exactly as sent; agree on one.`);
  }
  const ids = new Map();
  for (const e of clean.filter((x) => x.state === 'OCCUPIED' && x.pallet)) { const k = e.pallet.toUpperCase(); if (!ids.has(k)) ids.set(k, new Set()); ids.get(k).add(e.company); }
  for (const [id, cos] of ids) if (cos.size > 1) add('warning', 'same_id_two_companies', null, `Pallet id ${id} is used by both ${[...cos].join(' and ')}. Nexus allows it; confirm these are two different pallets.`);
  return { findings: f, rows: clean, byPos };
}
// what a sheet says stands at each position, as a comparable set
const picture = (byPos) => new Map(POSITIONS.map((p) => [p.code, (byPos.get(p.code) || []).filter((x) => x.state === 'OCCUPIED').map((x) => `${x.company} ${x.pallet}`).sort()]));

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// the baseline as data: every position, with the pallets standing in it (company and id, as written on the pallet)
const content = (byPos) => POSITIONS.map((p) => ({ position: p.code, pallets: (byPos.get(p.code) || []).filter((x) => x.state === 'OCCUPIED').map((x) => ({ company: x.company, pallet: x.pallet })).sort((a, b) => cmp(a.company, b.company) || cmp(a.pallet, b.pallet)) })).sort((a, b) => cmp(a.position, b.position));
// Nexus computes exactly this from the same data and refuses a report whose fingerprint differs
export const fingerprintOf = (baseline, mapVersion = MAP_VERSION, mapChecksum = MAP_CHECKSUM) => crypto.createHash('sha256').update(`nexus-baseline v2\nmap v${mapVersion} ${mapChecksum}\n` +
  baseline.flatMap((e) => (e.pallets.length ? e.pallets.map((p) => [e.position, p.company, p.pallet]) : [[e.position, '', '']])).sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]) || cmp(a[2], b[2])).map((l) => l.join('\t')).join('\n')).digest('hex');

export function validate({ count, second = null, wms = {}, testIds = [], capacity = {}, mapVersion = MAP_VERSION, mapChecksum = MAP_CHECKSUM }) {
  for (const [code, n] of Object.entries(capacity)) if (!KNOWN.has(code) || !Number.isInteger(n) || n < 1) throw new Error(`--capacity ${code}=${n}: a known position and a whole number of one or more`);
  const opts = { testIds: new Set(testIds.map((x) => x.trim().toUpperCase()).filter(Boolean)), capacity };
  const a = readCount(count, 'count 1', opts); const findings = [...a.findings];
  let b = null;
  if (second) {
    b = readCount(second, 'count 2', opts); findings.push(...b.findings);
    const pa = picture(a.byPos), pb = picture(b.byPos);
    for (const p of POSITIONS) {
      const x = pa.get(p.code), y = pb.get(p.code); if (!a.byPos.has(p.code) || !b.byPos.has(p.code)) continue;
      if (x.join('|').toUpperCase() !== y.join('|').toUpperCase()) findings.push({ level: 'error', code: 'counts_disagree', sheet: 'both', position: p.code, message: `${p.code}: count 1 says ${x.length ? x.join(', ') : 'EMPTY'}; count 2 says ${y.length ? y.join(', ') : 'EMPTY'}. Go back to the position together.` });
    }
    const who = (r) => new Set(r.rows.map((x) => x.counted_by.toLowerCase()).filter(Boolean)); const wa = who(a), wb = who(b);
    if ([...wa].some((n) => wb.has(n))) findings.push({ level: 'error', code: 'same_counter', sheet: 'both', position: null, message: 'The same person appears on both counts. The two counts are made by different people, one from each company.' });
  } else findings.push({ level: 'error', code: 'single_count', sheet: 'count 1', position: null, message: 'Only one count was supplied. A baseline needs two independent counts that agree.' });
  for (const [company, rows] of Object.entries(wms)) {
    const co = norm(company); if (!COMPANIES.includes(co)) { findings.push({ level: 'error', code: 'unknown_owner', sheet: `${company} export`, position: null, message: `"${company}" is not SOULED or SHIPBAY.` }); continue; }
    const floor = new Map(a.rows.filter((x) => x.state === 'OCCUPIED' && x.company === co && x.pallet).map((x) => [x.pallet.toUpperCase(), x]));
    const book = new Map(rows.filter((r) => (r.pallet_id || '').trim()).map((r) => [r.pallet_id.trim().toUpperCase(), { pallet: r.pallet_id.trim(), position: norm(r.position) }]));
    for (const [id, w] of book) {
      const fl = floor.get(id);
      if (!fl) findings.push({ level: 'discrepancy', code: 'in_wms_not_on_floor', sheet: `${co} export`, position: w.position || null, message: `${co}'s system lists ${w.pallet}${w.position ? ` at ${w.position}` : ''}; the count did not find it on the shared floor.` });
      else if (w.position && w.position !== fl.position) findings.push({ level: 'discrepancy', code: 'position_differs', sheet: `${co} export`, position: fl.position, message: `${w.pallet}: counted at ${fl.position}; ${co}'s system says ${w.position}. The count is the baseline; ${co} corrects its own record.` });
    }
    for (const [id, fl] of floor) if (!book.has(id)) findings.push({ level: 'discrepancy', code: 'on_floor_not_in_wms', sheet: `${co} export`, position: fl.position, message: `${fl.pallet} was counted at ${fl.position} as ${co}'s, but ${co}'s system does not list it.` });
  }
  const errors = findings.filter((x) => x.level === 'error'), discrepancies = findings.filter((x) => x.level === 'discrepancy'), warnings = findings.filter((x) => x.level === 'warning');
  const baseline = content(a.byPos); const fingerprint = fingerprintOf(baseline, mapVersion, mapChecksum);
  const occupied = a.rows.filter((x) => x.state === 'OCCUPIED');
  const ready = errors.length === 0 && discrepancies.length === 0;
  const names = (r) => [...new Set(r.rows.map((x) => x.counted_by).filter(Boolean))].sort();
  return { format_version: 2, dry_run: true, wrote_anything: false, map_version: mapVersion, map_checksum: mapChecksum, ready_for_joint_approval: ready, capacity_used: Object.fromEntries(POSITIONS.filter((p) => capacity[p.code] != null).map((p) => [p.code, capacity[p.code]])),
    counters: { count_1: names(a), count_2: b ? names(b) : [] },
    summary: { positions_on_map: POSITIONS.length, positions_recorded: POSITIONS.filter((p) => a.byPos.has(p.code)).length, occupied_positions: new Set(occupied.map((x) => x.position)).size,
      empty_positions: POSITIONS.filter((p) => (a.byPos.get(p.code) || []).length && (a.byPos.get(p.code) || []).every((x) => x.state === 'EMPTY')).length,
      pallets: Object.fromEntries(COMPANIES.map((c) => [c, occupied.filter((x) => x.company === c).length])), errors: errors.length, discrepancies: discrepancies.length, warnings: warnings.length },
    baseline_fingerprint: ready ? fingerprint : null, baseline: ready ? baseline : null, findings };
}
export function report(r) {
  const s = r.summary; const out = ['NEXUS BASELINE VALIDATION: DRY RUN. Nothing was written anywhere.', `Map version ${r.map_version} (${r.map_checksum.slice(0, 16)}…)`, '',
    `Positions recorded: ${s.positions_recorded} of ${s.positions_on_map}   occupied: ${s.occupied_positions}   empty: ${s.empty_positions}`, `Pallets: ${Object.entries(s.pallets).map(([c, n]) => `${c} ${n}`).join('   ')}`,
    `Errors: ${s.errors}   Discrepancies with company systems: ${s.discrepancies}   Warnings: ${s.warnings}`, ''];
  for (const [level, title] of [['error', 'ERRORS (fix on the floor or on the sheet, then run again)'], ['discrepancy', 'DISCREPANCIES (each company settles its own records, or the count is redone)'], ['warning', 'WARNINGS (read and confirm)']]) {
    const list = r.findings.filter((x) => x.level === level); if (!list.length) continue;
    out.push(title); for (const x of list) out.push(`  [${x.code}] ${x.message}`); out.push('');
  }
  out.push(r.ready_for_joint_approval ? `READY FOR JOINT APPROVAL. Baseline fingerprint:\n  ${r.baseline_fingerprint}\nBoth companies approve this exact fingerprint. Any change to the sheet changes it.` : 'NOT READY. No fingerprint is issued until errors and discrepancies are zero.');
  return out.join('\n');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; }; const all = (k) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
  if (!get('--count')) { console.error('usage: node validate.mjs --count count-A.csv [--second count-B.csv] [--wms SOULED=file.csv] [--wms SHIPBAY=file.csv] [--test-ids ids.txt] [--json out.json]'); process.exit(2); }
  const csv = (f) => parseCsv(fs.readFileSync(f, 'utf8'));
  const r = validate({ count: csv(get('--count')), second: get('--second') ? csv(get('--second')) : null, wms: Object.fromEntries(all('--wms').map((x) => { const [c, ...f] = x.split('='); return [c, csv(f.join('='))]; })),
    testIds: get('--test-ids') ? fs.readFileSync(get('--test-ids'), 'utf8').split(/\r?\n/) : [], capacity: Object.fromEntries(all('--capacity').map((x) => { const [c, n] = x.split('='); return [c.trim().toUpperCase(), Number(n)]; })) });
  if (get('--json')) fs.writeFileSync(get('--json'), JSON.stringify(r, null, 2));
  console.log(report(r)); process.exit(r.ready_for_joint_approval ? 0 : 1);
}
