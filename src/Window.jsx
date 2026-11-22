// A Nexus window inside another site: no login, a connection key decides everything. ?window=floor shows the live floor
// (free and used positions, scan a pallet into a position). ?window=admin adds the shipment calendar and that site's labels.
// The key rides in the #fragment, and every answer comes from a nexus_api_* function that checks it.
import { useEffect, useRef, useState } from 'react';
import { rpc, WINDOW_KEY as KEY, stamp } from './lib.js';
import FloorMap, { Legend, capacity } from './FloorMap.jsx';
import CalendarPage from './Calendar.jsx';
import { LabelTable } from './Labels.jsx';
import { Msg } from './parts.jsx';

export default function Window() {
  const [w, setW] = useState(null); const [err, setErr] = useState(null); const [tab, setTab] = useState('floor');
  const load = () => rpc('nexus_api_window', { p_key: KEY }).then((d) => { setW(d); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, []);   // permission changes reach an open window within a minute
  if (err && !w) return <div className="center"><img src="/brand/nexus-logo.png" alt="Nexus" style={{ width: 220 }} /><p>{KEY ? 'This Nexus key is not recognised or has been turned off.' : 'No Nexus key was given.'}</p></div>;
  if (!w) return <div className="center">Connecting to Nexus…</div>;
  const tabs = [['floor', 'Floor', w.can.map], ['calendar', 'Calendar', w.access === 'admin' && w.can.calendar], ['labels', 'Labels', w.access === 'admin' && w.can.labels]].filter((t) => t[2]);
  const api = { shipments: (a, b) => rpc('nexus_api_shipments', { p_key: KEY, p_from: a, p_to: b }), save: (s) => rpc('nexus_api_shipment_save', { p_key: KEY, p_body: { id: s.id, org_id: s.org_id, reference: s.reference, origin: s.origin, expected_at: s.expected_at, pallets: Number(s.pallets), cartons: Number(s.cartons || 0), notes: s.notes || '', cancel: !!s.cancel } }) };
  const cur = tabs.some((t) => t[0] === tab) ? tab : tabs[0]?.[0];
  return (
    <div className="window" data-testid="window">
      <header className="wintop"><img src="/brand/nexus-logo.png" alt="Nexus" /><nav>{tabs.map(([k, l]) => <button key={k} className={cur === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</nav>
        <div className="who"><b>{w.name}</b><small>{w.access === 'admin' ? 'Admin window' : 'Floor window'} · live</small></div></header>
      <main>
        {!cur && <div className="empty">This key has no screens turned on.</div>}
        {cur === 'floor' && <WinFloor can={w.can} />}
        {cur === 'calendar' && <CalendarPage api={api} canEdit brands={w.brands} note="A new booking shows as waiting until Nexus confirms it." />}
        {cur === 'labels' && <WinLabels />}
      </main>
    </div>);
}
function WinFloor({ can }) {
  const [m, setM] = useState(null); const [err, setErr] = useState(null); const [sel, setSel] = useState(null); const [psku, setPsku] = useState(''); const [loc, setLoc] = useState(''); const [msg, setMsg] = useState(null); const pRef = useRef(null);
  const load = () => rpc('nexus_api_floor', { p_key: KEY }).then((d) => { setM(d); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); const t = setInterval(load, 8000); const vis = () => { if (!document.hidden) load(); }; document.addEventListener('visibilitychange', vis); return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); }; }, []);
  if (err && !m) return <Msg m={{ text: err }} />; if (!m) return <div className="empty">Loading…</div>;
  const cap = capacity(m); const s = sel && m.positions.find((p) => p.code === sel);
  const scan = async (e) => { e.preventDefault(); try { const r = await rpc('nexus_api_scan', { p_key: KEY, p_psku: psku, p_location: loc }); setMsg({ kind: 'ok', text: `${r.psku} ${r.put_away ? 'put away at' : 'moved to'} ${r.to}.` }); setPsku(''); setLoc(''); pRef.current?.focus(); load(); } catch (x) { setMsg({ text: x.message }); } };
  return (
    <>
      <div className="head"><h1>Floor</h1><div className="glance"><div><b>{cap.free}</b><small>Positions free</small></div><div><b>{cap.used}</b><small>In use</small></div><div><b>{cap.total}</b><small>Positions</small></div></div></div>
      {can.scan && <form className="filters" onSubmit={scan} data-testid="win-scan"><input ref={pRef} aria-label="Pallet" placeholder="Scan pallet label" value={psku} onChange={(e) => setPsku(e.target.value)} /><input aria-label="Position" placeholder="Scan position label" value={loc} onChange={(e) => setLoc(e.target.value)} /><button className="btn primary" disabled={!psku.trim() || !loc.trim()}>Put it there</button></form>}
      <Msg m={msg} />
      <div className="floor"><div><FloorMap m={m} sel={sel} onSel={(c) => { setSel(sel === c ? null : c); if (can.scan && m.positions.find((p) => p.code === c && !p.taken)) setLoc(c); }} /><Legend m={m} own /><p className="sm">Live from Nexus · {stamp(m.as_of)}</p></div>
        <aside>
          {s ? <section data-testid="cell-detail"><h2>Position {s.code}</h2>{!s.taken ? <p className="sm">Free.</p> : s.pallets.length === 0 ? <p className="sm">In use.</p> : s.pallets.map((x) => <div className="pal" key={x.psku}><b className="code">{x.psku}</b> · {x.brand}{x.held ? ' · ON HOLD' : ''}<div className="sm">{x.item || '—'} · {x.cartons ?? '—'} cartons · {x.units ?? '—'} units · {x.age_days}d</div></div>)}</section>
            : <section><h2>Positions</h2><p className="sm">Click a position to see it.{can.scan ? ' Clicking a free one fills it in as where the pallet goes.' : ''}</p></section>}
          {m.unplaced.length > 0 && <section data-testid="unplaced"><h2>Received, no position yet · {m.unplaced.length}</h2>{m.unplaced.slice(0, 12).map((x) => <div className="pal" key={x.psku}><button className="link code" onClick={() => setPsku(x.psku)}>{x.psku}</button> · {x.brand}{x.held ? ' · ON HOLD' : ''}<div className="sm">{x.item || '—'} · {stamp(x.received_at)}</div></div>)}</section>}
        </aside></div>
    </>);
}
function WinLabels() {
  const [q, setQ] = useState(''); const [rows, setRows] = useState(null); const [err, setErr] = useState(null);
  useEffect(() => { let on = true; const load = () => rpc('nexus_api_labels', { p_key: KEY, p_q: q || null }).then((d) => on && (setRows(d), setErr(null))).catch((e) => on && setErr(e.message)); load(); const t = setInterval(load, 20000); return () => { on = false; clearInterval(t); }; }, [q]);
  return <><div className="head"><h1>Labels</h1><div className="glance"><div><b>{rows?.length ?? '—'}</b><small>Shown</small></div></div></div>
    <div className="filters"><input aria-label="Search" placeholder="Label, pallet or item…" value={q} onChange={(e) => setQ(e.target.value)} /></div>{err && <Msg m={{ text: err }} />}{rows && <LabelTable rows={rows} />}{rows && rows.length === 0 && <div className="empty">No labels yet.</div>}</>;
}
