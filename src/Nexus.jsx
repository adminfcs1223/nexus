// Nexus screens. Every read and write goes through a nexus_* function.
import { useEffect, useRef, useState } from 'react';
import { supabase, rpc, num, day, stamp, EMBED_VIEW } from './lib.js';
import { useRpc } from './hooks.js';
import FloorMap, { Legend } from './FloorMap.jsx';
import Floor from './Floor.jsx';
import CalendarPage, { MonthGrid, useMonth, staffApi, nextDays } from './Calendar.jsx';
import Labels from './Labels.jsx';
import Receiving from './Receiving.jsx';
import { Putaway } from './Dock.jsx';
import { Ring, Msg, Pill, PalletEditor, what } from './parts.jsx';

// [key, label, parent]: Calendar and Labeling sit under Dashboard
const TABS = [['dashboard', 'Dashboard'], ['calendar', 'Calendar', 'dashboard'], ['labels', 'Labeling', 'dashboard'], ['receiving', 'Receiving'], ['putaway', 'Put-away'], ['floor', 'Floor'], ['pallets', 'Pallets'], ['fifo', 'FIFO'], ['counts', 'Cycle counts'], ['connections', 'Connections']];
const RESULT = { pending: 'Not counted yet', found: 'Found', misplaced: 'Wrong position', missing: 'Missing', unexpected: 'Not expected here' };

export default function Nexus({ me, onSignOut, embed }) {
  const [tab, setTab] = useState('dashboard'); const [pallet, setPallet] = useState(null);
  const [ov, ovErr] = useRpc(embed ? null : 'nexus_overview', {}, []);
  if (embed) return <main className="embed">{EMBED_VIEW === 'receiving' ? <Receiving me={me} /> : <EmbedMap />}</main>;   // inside a WMS: the floor map, or with ?embed=receiving the Receiving screen
  const brands = ov?.brands || []; const zones = (ov?.zones || []).map((z) => z.zone).filter((z) => z !== '—');
  const admin = me.role === 'shipbay_admin'; const tabs = TABS.filter(([k]) => k !== 'connections' || admin);
  const openPallet = (psku) => { setPallet(psku); setTab('pallets'); };
  return (
    <div className="shell">
      <header className="top">
        <img src="/brand/nexus-logo.png" alt="Nexus" />
        <nav>{tabs.map(([k, l, parent]) => <button key={k} className={`${tab === k ? 'on' : ''}${parent ? ' subtab' : ''}`} onClick={() => { setTab(k); setPallet(null); }}>{l}</button>)}</nav>
        <div className="who"><b>{me.full_name || me.email}</b><small>{admin ? 'Admin' : me.role === 'shipbay_staff' ? 'Staff' : 'Floor'}</small>{onSignOut && <button onClick={onSignOut}>Sign out</button>}</div>
      </header>
      <main>
        {ovErr && <Msg m={{ text: ovErr }} />}
        {tab === 'dashboard' && <Dashboard ov={ov} go={setTab} openPallet={openPallet} />}
        {tab === 'calendar' && <CalendarPage api={staffApi} canEdit={me.role !== 'wms_employee'} />}
        {tab === 'labels' && <Labels brands={brands} />}
        {tab === 'receiving' && <Receiving me={me} />}
        {tab === 'putaway' && <Putaway />}
        {tab === 'floor' && <Floor me={me} openPallet={openPallet} />}
        {tab === 'pallets' && <Pallets brands={brands} me={me} open={pallet} setOpen={setPallet} />}
        {tab === 'fifo' && <><div className="head"><h1>FIFO</h1></div><div className="construction" data-testid="construction"><b>Under construction</b><span>This page is being rebuilt.</span></div></>}
        {tab === 'counts' && <Counts brands={brands} zones={zones} />}
        {tab === 'connections' && <Connections />}
      </main>
    </div>
  );
}
// inside the ShipBay WMS (?embed): the live map only, as before
function EmbedMap() {
  const [m, err] = useRpc('nexus_map', {}, [], 10000); const [sel, setSel] = useState(null);
  if (err && !m) return <Msg m={{ text: `Nexus could not be read (${err}).` }} />; if (!m) return <div className="empty">Loading…</div>;
  const s = sel && m.positions.find((p) => p.code === sel);
  return <div className="floor compact"><div><FloorMap m={m} sel={sel} onSel={(c) => setSel(sel === c ? null : c)} /><Legend m={m} /></div>
    <aside>{s ? <section data-testid="cell-detail"><h2>Position {s.code}</h2>{s.pallets.length === 0 ? <p className="sm">Free.</p> : s.pallets.map((x) => <div className="pal" key={x.psku}><b className="code">{x.psku}</b> · {x.brand}{x.held ? ' · ON HOLD' : ''}<div className="sm">{x.item || '—'} · {x.cartons ?? '—'} cartons · {x.units ?? '—'} units</div></div>)}</section> : <p className="sm">Live · {stamp(m.as_of)}</p>}
      {m.unplaced.length > 0 && <section><h2>Received, no position yet · {m.unplaced.length}</h2>{m.unplaced.slice(0, 12).map((x) => <div className="pal" key={x.psku}><b className="code">{x.psku}</b> · {x.brand}</div>)}</section>}</aside></div>;
}

function Dashboard({ ov, go, openPallet }) {
  const [m] = useRpc('nexus_map', {}, [], 10000); const [d] = useRpc('nexus_dashboard', {}, [], 15000); const cal = useMonth(staffApi);
  if (!ov || !m) return <div className="empty">Loading…</div>;
  const t = ov.brands.reduce((a, b) => ({ s: a.s + b.pallets_stored, w: a.w + b.pallets_waiting, h: a.h + b.pallets_on_hold }), { s: 0, w: 0, h: 0 });
  const soon = nextDays(cal.rows, 7);
  return (
    <>
      <div className="head"><h1>Dashboard</h1>
        <div className="glance" data-testid="glance">
          <div><b>{num(t.s)}</b><small>Pallets stored</small></div><div><b className={t.w ? 'hot' : ''}>{num(t.w)}</b><small>Waiting for put-away</small></div>
          <div><b className={t.h ? 'hot' : ''}>{num(t.h)}</b><small>On hold</small></div><div><b>{num(soon.reduce((a, s) => a + s.pallets, 0))}</b><small>Pallets arriving in 7 days</small></div>
        </div></div>
      <div className="today"><span>Today</span><div><b>{num(d?.received_today)}</b> pallets received</div><div><b>{num(d?.moves_today)}</b> moves on the floor</div><div><b>{num(d?.labels_today)}</b> labels made</div><div><b>{d?.oldest_days ?? 0}d</b> oldest pallet stored</div><div><b>{num(ov.open_counts)}</b> cycle counts open</div></div>
      <div className="grid3">
        <section className="click" onClick={() => go('floor')} data-testid="mini-map"><div className="row"><h2>Floor</h2><span className="sm">Open Floor ›</span></div><FloorMap m={m} size="mini" /><Legend m={m} /></section>
        <section><h2>Capacity</h2><Ring m={m} />
          {ov.zones.map((z) => <div className="zone" key={z.zone}><div><b>{z.zone}</b><span>{z.used} of {z.positions}</span></div><div className="bar"><i style={{ width: `${z.positions ? Math.round((z.used / z.positions) * 100) : 0}%` }} /></div></div>)}</section>
        <section><div className="row"><h2>Incoming shipments</h2><button className="link sm" onClick={() => go('calendar')}>Open Calendar ›</button></div><MonthGrid cal={cal} mini onDay={() => go('calendar')} />
          <h2 className="sub">Next 7 days</h2>{soon.length === 0 ? <p className="sm">Nothing booked.</p> : soon.map((s) => <div className="hist" key={s.id}><b>{s.pallets} pallets</b> {s.brand} · {s.reference}<span>{day(`${s.expected_at}T12:00`)}{s.approved ? '' : ' · waiting to be confirmed'}</span></div>)}</section>
      </div>
      <div className="grid3">
        <section><h2>By brand</h2>
          <table data-testid="brand-table"><thead><tr><th>Brand</th><th className="n">Stored</th><th className="n">Waiting</th><th className="n">Hold</th><th className="n">Units</th></tr></thead>
            <tbody>{ov.brands.map((b) => <tr key={b.org_id}><td><b>{b.brand}</b></td><td className="n">{num(b.pallets_stored)}</td><td className="n">{num(b.pallets_waiting)}</td><td className="n">{num(b.pallets_on_hold)}</td><td className="n">{num(b.units_on_hand)}</td></tr>)}</tbody></table>
          {ov.brands.length === 0 && <div className="empty">No pallets on file yet.</div>}</section>
        <section><h2>Not put away yet</h2>{(d?.waiting || []).length === 0 ? <p className="sm">Everything received is in a position.</p> : d.waiting.map((x) => <div className="hist" key={x.psku}><button className="link code" onClick={() => openPallet(x.psku)}>{x.psku}</button> {x.brand}<span>{x.item || '—'} · received {stamp(x.received_at)}{x.held ? ' · ON HOLD' : ''}</span></div>)}</section>
        <section><h2>Latest on the floor</h2>{(d?.log || []).map((h, i) => <div className="hist" key={i}><b>{h.psku || h.to}</b> {what(h)}<span>{stamp(h.at)} · {h.by || h.source}</span></div>)}{d && d.log.length === 0 && <p className="sm">Nothing yet.</p>}</section>
      </div>
    </>
  );
}

const csv = (rows) => { const cols = ['psku', 'org_name', 'item_name', 'item_no', 'location_code', 'zone', 'status', 'held', 'cartons', 'units_total', 'received_at', 'stored_at', 'age_days', 'label_prints'];
  const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };   // no spreadsheet formulas from data
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([[cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n')], { type: 'text/csv' })); a.download = `nexus-pallets-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(a.href); };

function Pallets({ brands, me, open, setOpen }) {
  const [org, setOrg] = useState(''); const [q, setQ] = useState(''); const [status, setStatus] = useState(''); const [zone, setZone] = useState('');
  const [rows, err, reload] = useRpc('nexus_pallets', { p_org: org || null, p_q: q || null }, [org, q]);
  if (open) return <PalletDetail psku={open} me={me} back={() => { setOpen(null); reload(); }} />;
  const zones = [...new Set((rows || []).map((r) => r.zone).filter(Boolean))].sort();
  const list = (rows || []).filter((r) => (!status || (status === 'held' ? r.held : r.status === status && !r.held)) && (!zone || r.zone === zone));
  const sum = (k) => list.reduce((a, r) => a + (r[k] || 0), 0);
  return (
    <>
      <div className="head"><h1>Pallets</h1><div className="glance"><div><b>{num(list.length)}</b><small>Pallets shown</small></div><div><b>{num(sum('cartons'))}</b><small>Cartons</small></div><div><b>{num(sum('units_total'))}</b><small>Units</small></div><div><b>{list.length ? Math.max(...list.map((r) => r.age_days)) : 0}d</b><small>Oldest</small></div></div></div>
      <div className="filters">
        <select aria-label="Brand" value={org} onChange={(e) => setOrg(e.target.value)}><option value="">All brands</option>{brands.map((b) => <option key={b.org_id} value={b.org_id}>{b.brand}</option>)}</select>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option><option value="stored">Stored</option><option value="counted">To put away</option><option value="open">Not put away</option><option value="held">On hold</option></select>
        <select aria-label="Zone filter" value={zone} onChange={(e) => setZone(e.target.value)}><option value="">Any zone</option>{zones.map((z) => <option key={z}>{z}</option>)}</select>
        <input aria-label="Search" placeholder="Pallet, position or item…" value={q} onChange={(e) => setQ(e.target.value)} /><span className="spacer" /><button className="btn" onClick={() => csv(list)} disabled={!list.length}>Download this list</button>
      </div>
      {err && <Msg m={{ text: err }} />}
      <table data-testid="pallet-table"><thead><tr><th>Pallet</th><th>Brand</th><th>Item</th><th>Position</th><th>Zone</th><th>Status</th><th className="n">Cartons</th><th className="n">Units</th><th>Received</th><th>Put away</th><th className="n">Age</th><th className="n">Label</th></tr></thead>
        <tbody>{list.map((r) => <tr key={r.id} onClick={() => setOpen(r.psku)} style={{ cursor: 'pointer' }}><td className="code">{r.psku}</td><td>{r.org_name}</td><td>{r.item_name}{r.mixed ? <span className="sm"> · mixed</span> : null}{r.item_no ? <span className="sm"> · {r.item_no}</span> : null}</td><td className="code">{r.location_code || '—'}</td><td>{r.zone || '—'}</td>
          <td><Pill p={r} /></td><td className="n">{r.cartons ?? '—'}</td><td className="n">{r.units_total ?? '—'}</td><td>{day(r.received_at)}</td><td>{r.stored_at ? day(r.stored_at) : '—'}</td><td className="n">{r.age_days}d</td><td className="n" title={r.last_printed_at ? `last ${stamp(r.last_printed_at)}` : ''}>{r.label_prints ? `${r.label_prints}×` : 'Not printed'}</td></tr>)}</tbody></table>
      {rows && list.length === 0 && <div className="empty">Nothing matches.</div>}
    </>
  );
}

function PalletDetail({ psku, me, back }) {
  const admin = me.role === 'shipbay_admin'; const canMove = admin || me.role === 'shipbay_staff';
  const [p, err, reload] = useRpc('nexus_pallet_detail', { p_psku: psku }, [psku], 10000);
  const [mode, setMode] = useState(null); const [to, setTo] = useState(''); const [why, setWhy] = useState(''); const [msg, setMsg] = useState(null);
  const run = async (fn, text) => { try { await fn(); setMsg({ kind: 'ok', text }); setMode(null); setTo(''); setWhy(''); reload(); } catch (x) { setMsg({ text: x.message }); } };
  if (!p) return <><button className="back" onClick={back}>‹ Pallets</button>{err ? <Msg m={{ text: err }} /> : <div className="empty">Loading…</div>}</>;
  const F = ({ k, v }) => <span>{k}<b>{v ?? '—'}</b></span>; const live = p.status !== 'void';
  return (
    <>
      <div className="head"><div><button className="back" onClick={back}>‹ Pallets</button><h1>{p.psku}</h1></div>
        <div className="glance"><div><b>{p.position || '—'}</b><small>Position</small></div><div><b>{p.cartons ?? '—'}</b><small>Cartons</small></div><div><b>{num(p.on_hand)}</b><small>Units on hand</small></div><div><b>{p.label_prints}×</b><small>Label printed</small></div></div></div>
      <Msg m={msg} />
      <div className="grid2">
        <div>
          <section data-testid="pallet-facts"><div className="row"><h2>{p.brand}</h2><Pill p={p} /></div>
            <div className="facts wide"><F k="Item" v={p.item} /><F k="Item number" v={p.item_no} /><F k="SKU" v={p.sku} /><F k="Zone" v={p.zone} /><F k="Units per carton" v={p.units_per_carton} /><F k="Units entered" v={p.units_total} />
              <F k="Cartons scanned" v={`${p.cartons_scanned} of ${p.cartons_made}`} /><F k="Type" v={[p.mixed && 'Mixed', p.fba && 'FBA', p.ncc && 'No carton count'].filter(Boolean).join(' · ') || 'Standard'} /><F k="Reference" v={p.reference} /><F k="Booked shipment" v={p.booking} /><F k="Carrier" v={p.carrier} /><F k="Notes" v={p.notes} />
              <F k="Received" v={`${stamp(p.received_at)}${p.received_by ? ` · ${p.received_by}` : ''}`} /><F k="Cartons counted" v={p.counted_at ? `${stamp(p.counted_at)} · ${p.counted_by || ''}` : null} /><F k="Put away" v={p.stored_at ? `${stamp(p.stored_at)} · ${p.stored_by || ''}` : null} /><F k="Label last printed" v={p.last_printed_at ? stamp(p.last_printed_at) : null} />
              {p.held && <F k="On hold" v={p.hold_reason} />}{p.status === 'void' && <F k="Voided" v={`${stamp(p.voided_at)} · ${p.void_reason}`} />}</div></section>
          {live && (canMove || admin) && <section data-testid="pallet-admin"><h2>Admin</h2>
            {!mode && <div className="acts">{canMove && <button className="btn primary" onClick={() => setMode('move')}>{p.status === 'stored' ? 'Move to another position' : 'Put away'}</button>}{admin && <button className="btn" onClick={() => setMode('edit')}>Override details</button>}{admin && <button className="btn danger" onClick={() => setMode('void')}>Void pallet</button>}</div>}
            {mode === 'move' && <form className="acts" onSubmit={(e) => { e.preventDefault(); run(() => rpc('nexus_move_pallet', { p_psku: p.psku, p_location: to, p_reason: why || null, p_store: p.status !== 'stored' }), `${p.psku} is now at ${to.toUpperCase()}.`); }}>
              <input aria-label="To position" placeholder="Position, e.g. P-14" value={to} onChange={(e) => setTo(e.target.value)} required /><input aria-label="Reason" placeholder="Reason (optional)" value={why} onChange={(e) => setWhy(e.target.value)} /><button className="btn primary">{p.status === 'stored' ? 'Move' : 'Put away'}</button><button type="button" className="btn" onClick={() => setMode(null)}>Cancel</button></form>}
            {mode === 'edit' && <PalletEditor p={p} onCancel={() => setMode(null)} onSave={(c, r) => run(() => rpc('nexus_pallet_edit', { p_psku: p.psku, p_changes: c, p_reason: r }), 'Details changed. The WMS shows the new details.')} />}
            {mode === 'void' && <form className="acts" onSubmit={(e) => { e.preventDefault(); run(() => rpc('nexus_pallet_void', { p_psku: p.psku, p_reason: why }), `${p.psku} voided. Its stock was taken off the floor.`); }}>
              <input aria-label="Reason" placeholder="Why is this pallet being voided?" value={why} onChange={(e) => setWhy(e.target.value)} required style={{ minWidth: 320 }} /><button className="btn danger">Void {p.psku}</button><button type="button" className="btn" onClick={() => setMode(null)}>Cancel</button></form>}</section>}
          <section><h2>History</h2>{p.history.map((h, i) => <div className="hist" key={i}><b>{what(h)}</b><span>{stamp(h.at)} · {h.by || '—'} · {h.source}{h.reason ? ` · “${h.reason}”` : ''}</span></div>)}{p.history.length === 0 && <p className="sm">Nothing logged.</p>}</section>
        </div>
        <div>
          <section><h2>Cartons · {p.cartons_scanned} of {p.cartons_made} scanned</h2><div className="tiles">{p.carton_list.map((c) => <i key={c.code} className={`${c.scanned_at ? 'ok' : ''}${c.open_box ? ' ob' : ''}`} title={`${c.code}${c.scanned_at ? ` · scanned ${stamp(c.scanned_at)}` : ' · not scanned'}${c.open_box ? ' · open box' : ''}`}>{c.seq}</i>)}</div>{p.carton_list.length === 0 && <p className="sm">No carton labels on this pallet.</p>}</section>
          <section><h2>Labels on file · {p.labels.length}</h2><table><thead><tr><th>Label</th><th>Kind</th><th>From</th><th className="n">Printed</th></tr></thead><tbody>{p.labels.slice(0, 40).map((l) => <tr key={l.kind + l.code}><td className="code">{l.code}</td><td>{l.kind}</td><td>{l.source}</td><td className="n">{l.prints ? `${l.prints}×` : '—'}</td></tr>)}</tbody></table>{p.labels.length > 40 && <p className="sm">{p.labels.length - 40} more under Labeling.</p>}</section>
        </div>
      </div>
    </>);
}

function Counts({ brands, zones }) {
  const [list, err, reload] = useRpc('nexus_counts_list', {}, []);
  const [open, setOpen] = useState(null); const [zone, setZone] = useState(''); const [org, setOrg] = useState(''); const [msg, setMsg] = useState(null);
  const start = async () => {
    setMsg(null); const { data, error } = await supabase.rpc('nexus_count_start', { p_zone: zone || null, p_org: org || null });
    if (error) return setMsg({ kind: 'bad', text: error.message }); await reload(); setOpen(data);
  };
  if (open) return <Count id={open} info={(list || []).find((c) => c.id === open)} back={() => { setOpen(null); reload(); }} />;
  return (
    <>
      <div className="head"><h1>Cycle counts</h1></div>
      <div className="filters">
        <select aria-label="Zone" value={zone} onChange={(e) => setZone(e.target.value)}><option value="">Whole warehouse</option>{zones.map((z) => <option key={z} value={z}>Zone {z}</option>)}</select>
        <select aria-label="Brand" value={org} onChange={(e) => setOrg(e.target.value)}><option value="">All brands</option>{brands.map((b) => <option key={b.org_id} value={b.org_id}>{b.brand}</option>)}</select>
        <button className="btn primary" onClick={start}>Start a count</button>
      </div>
      {(msg || err) && <div className="strip bad">{msg?.text || err}</div>}
      <table data-testid="count-table"><thead><tr><th>Started</th><th>Area</th><th>By</th><th>Status</th><th className="n">Found</th><th className="n">Wrong position</th><th className="n">Missing</th><th className="n">Not expected</th><th /></tr></thead>
        <tbody>{(list || []).map((c) => <tr key={c.id}><td>{stamp(c.started_at)}</td><td>{[c.zone ? `Zone ${c.zone}` : 'Whole warehouse', c.brand].filter(Boolean).join(' · ')}</td><td>{c.started_by}</td><td><span className={`pill ${c.status}`}>{c.status === 'open' ? 'Open' : 'Closed'}</span></td>
          <td className="n">{c.totals.found || 0}</td><td className="n">{c.totals.misplaced || 0}</td><td className="n">{c.totals.missing || 0}</td><td className="n">{c.totals.unexpected || 0}</td><td><button className="btn sm" onClick={() => setOpen(c.id)}>{c.status === 'open' ? 'Count' : 'View'}</button></td></tr>)}</tbody></table>
      {list && list.length === 0 && <div className="empty">No counts yet.</div>}
    </>
  );
}

function Count({ id, info, back }) {
  const [lines, err, reload] = useRpc('nexus_count_lines_list', { p_count: id }, [id]);
  const [loc, setLoc] = useState(''); const [psku, setPsku] = useState(''); const [last, setLast] = useState(null); const [closed, setClosed] = useState(info?.status === 'closed');
  const pRef = useRef(null); const lRef = useRef(null);
  const scan = async (e) => {
    e.preventDefault(); if (!loc.trim() || !psku.trim()) return;
    const { data, error } = await supabase.rpc('nexus_count_scan', { p_count: id, p_location: loc, p_psku: psku });
    setLast(error ? { kind: 'bad', text: error.message } : { kind: data.result === 'found' ? 'ok' : 'bad', text: `${data.psku}: ${RESULT[data.result]}${data.result === 'misplaced' ? ` (belongs in ${data.expected}, seen in ${data.seen})` : ''}` });
    setPsku(''); pRef.current?.focus(); reload();
  };
  const close = async () => { const { error } = await supabase.rpc('nexus_count_close', { p_count: id }); if (error) return setLast({ kind: 'bad', text: error.message }); setClosed(true); reload(); };
  const left = (lines || []).filter((l) => l.result === 'pending').length;
  return (
    <>
      <div className="head"><div><button className="back" onClick={back}>‹ Cycle counts</button><h1>{info?.zone ? `Zone ${info.zone}` : 'Whole warehouse'}{info?.brand ? ` · ${info.brand}` : ''}</h1></div>
        <div className="glance"><div><b className={left ? 'hot' : ''}>{left}</b><small>Left to count</small></div><div><b>{(lines || []).length}</b><small>Pallets</small></div></div></div>
      {!closed && <form className="filters" onSubmit={scan}>
        <input ref={lRef} aria-label="Position" placeholder="Scan position" value={loc} onChange={(e) => setLoc(e.target.value)} autoFocus />
        <input ref={pRef} aria-label="Pallet" placeholder="Scan pallet label" value={psku} onChange={(e) => setPsku(e.target.value)} />
        <button className="btn primary">Record</button><span className="spacer" /><button type="button" className="btn" onClick={close}>Finish count</button>
      </form>}
      {closed && <div className="strip ok">Count closed. Nothing was moved or adjusted; the differences below are for an admin to act on.</div>}
      {(last || err) && <div className={`strip ${last?.kind || 'bad'}`} data-testid="count-last">{last?.text || err}</div>}
      <table data-testid="line-table"><thead><tr><th>Pallet</th><th>Brand</th><th>Expected</th><th>Seen</th><th>Result</th><th>By</th></tr></thead>
        <tbody>{(lines || []).map((l) => <tr key={l.psku}><td className="code">{l.psku}</td><td>{l.brand}</td><td className="code">{l.expected || '—'}</td><td className="code">{l.seen || '—'}</td><td><span className={`pill r-${l.result}`}>{RESULT[l.result]}</span></td><td>{l.counted_by || '—'}</td></tr>)}</tbody></table>
    </>
  );
}


const PERMS = { floor: [['map', 'See the floor map'], ['brands', 'See its own pallets on the map'], ['scan', 'Scan pallets into positions']], admin: [['map', 'See the floor map'], ['brands', 'See its own pallets on the map'], ['scan', 'Scan pallets into positions'], ['calendar', 'Book and change incoming shipments'], ['labels', 'See its labels']] };
const DEFAULT = { floor: { map: true, brands: true, scan: true }, admin: { map: true, brands: true, scan: true, calendar: true, labels: true } };
const windowUrl = (access, key) => `${window.location.origin}/?window=${access}#k=${key}`;
function PermBoxes({ perms, set }) {
  return <div className="perms">{['floor', 'admin'].map((w) => <div key={w}><h2 className="sub">{w === 'floor' ? 'Floor key' : 'Admin key'}</h2>{PERMS[w].map(([k, l]) => <label key={k} className="chk"><input type="checkbox" checked={!!perms[w][k]} onChange={() => set({ ...perms, [w]: { ...perms[w], [k]: !perms[w][k] } })} />{l}</label>)}</div>)}</div>;
}
function KeyBox({ label, access, value }) {
  return <div className="strip ok keybox" data-testid={`key-${access}`}><b>{label}. Copy it now: it is shown once and not stored.</b><code>{value}</code><small>Address to load inside the other site</small><code>{windowUrl(access, value)}</code></div>;
}
function Connections() {
  const [list, err, reload] = useRpc('nexus_connections_list', {}, [], 60000); const [brands, setBrands] = useState([]);
  const [name, setName] = useState(''); const [picked, setPicked] = useState([]); const [perms, setPerms] = useState(DEFAULT); const [made, setMade] = useState(null); const [msg, setMsg] = useState(null); const [edit, setEdit] = useState(null);
  useEffect(() => { rpc('nexus_brands').then(setBrands).catch(() => {}); }, []);
  const Brands = ({ ids, set }) => <div className="checks">{brands.map((b) => <label key={b.id} className="chk"><input type="checkbox" checked={ids.includes(b.id)} onChange={() => set(ids.includes(b.id) ? ids.filter((x) => x !== b.id) : [...ids, b.id])} />{b.name}</label>)}</div>;
  const create = async (e) => { e.preventDefault(); setMsg(null); setMade(null); try { const d = await rpc('nexus_connection_save', { p_id: null, p_name: name, p_org_ids: picked, p_perms: perms }); setMade({ name, floor: d.floor_key, admin: d.admin_key }); setName(''); setPicked([]); setPerms(DEFAULT); reload(); } catch (x) { setMsg({ text: x.message }); } };
  const save = async () => { try { await rpc('nexus_connection_save', { p_id: edit.id, p_name: edit.name, p_org_ids: edit.org_ids, p_perms: edit.perms }); setMsg({ kind: 'ok', text: `${edit.name}: permissions saved. They apply from the window's next refresh.` }); setEdit(null); reload(); } catch (x) { setMsg({ text: x.message }); } };
  const newKey = async (c, access) => { try { const k = await rpc('nexus_connection_new_key', { p_id: c.id, p_access: access }); setMade({ name: c.name, [access]: k }); reload(); } catch (x) { setMsg({ text: x.message }); } };
  const toggle = async (c) => { await supabase.rpc('nexus_client_set_active', { p_id: c.id, p_active: !c.active }); reload(); };
  return (
    <>
      <div className="head"><h1>Connections</h1><div className="glance"><div><b>{(list || []).filter((c) => c.active).length}</b><small>Sites connected</small></div></div></div>
      <Msg m={msg || (err && { text: err })} />
      {made && <div data-testid="new-keys"><h2>Keys for {made.name}</h2>{made.floor && <KeyBox label="Floor key" access="floor" value={made.floor} />}{made.admin && <KeyBox label="Admin key" access="admin" value={made.admin} />}</div>}
      {(list || []).map((c) => { const e = edit?.id === c.id ? edit : null; return (
        <section key={c.id} className="conn" data-testid="connection">
          <div className="row"><h3>{c.name}</h3><div className="acts"><span className={`pill ${c.active ? 'stored' : 'closed'}`}>{c.active ? 'On' : 'Off'}</span><button className="btn sm" onClick={() => toggle(c)}>{c.active ? 'Turn off' : 'Turn on'}</button>{!e && <button className="btn sm primary" onClick={() => setEdit({ id: c.id, name: c.name, org_ids: c.org_ids, perms: c.perms })}>Change permissions</button>}</div></div>
          {!e ? <>
            <div className="facts wide"><span>Brands it can see<b>{c.brands.join(', ')}</b></span><span>Floor key last used<b>{stamp(c.floor_used_at)}</b></span><span>Admin key last used<b>{c.has_admin_key ? stamp(c.admin_used_at) : 'No admin key yet'}</b></span></div>
            <div className="perms read">{['floor', 'admin'].map((w) => <div key={w}><h2 className="sub">{w === 'floor' ? 'Floor key can' : 'Admin key can'}</h2>{PERMS[w].map(([k, l]) => <div key={k} className={c.perms[w][k] ? 'yes' : 'no'}>{c.perms[w][k] ? '✓' : '✕'} {l}</div>)}
              <button className="btn sm" onClick={() => newKey(c, w)}>{w === 'admin' && !c.has_admin_key ? 'Make the admin key' : `New ${w} key (the old one stops working)`}</button></div>)}</div></>
            : <div className="editor"><label>Name<input aria-label="Connection name" value={e.name} onChange={(x) => setEdit({ ...e, name: x.target.value })} /></label><h2 className="sub">Brands it can see</h2><Brands ids={e.org_ids} set={(ids) => setEdit({ ...e, org_ids: ids })} /><PermBoxes perms={e.perms} set={(p) => setEdit({ ...e, perms: p })} />
              <div className="acts"><button className="btn primary" onClick={save}>Save permissions</button><button className="btn" onClick={() => setEdit(null)}>Cancel</button></div></div>}
        </section>); })}
      {list && list.length === 0 && <div className="empty">No site is connected yet.</div>}
      <section><h2>Connect a site</h2>
        <form className="editor" onSubmit={create}>
          <label>Name<input aria-label="WMS name" placeholder="e.g. Souled Sneakers WMS" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <h2 className="sub">Brands it can see</h2><Brands ids={picked} set={setPicked} /><PermBoxes perms={perms} set={setPerms} />
          <div className="acts"><button className="btn primary" disabled={!name.trim() || !picked.length}>Create both keys</button></div>
        </form></section>
      <section className="api"><h2>How the two keys load into another site</h2>
        <p>Each connection has two keys. The floor key opens the floor window: the live map of free and used positions, and scanning a pallet into a position. The admin key opens the admin window: the same floor, plus the incoming-shipment calendar and that site's labels. A window only ever sees the brands ticked for its connection; other brands' positions show as in use with no detail.</p>
        <pre>{`<iframe src="${window.location.origin}/?window=floor#k=FLOOR_KEY"></iframe>\n<iframe src="${window.location.origin}/?window=admin#k=ADMIN_KEY"></iframe>`}</pre></section>
    </>
  );
}
