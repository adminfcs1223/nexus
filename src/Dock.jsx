// Nexus put-away: scan the pallet, scan the position. (The inbound calendar that used to share this file is Calendar.jsx.)
// Shared warehouse controls live here, not in any one WMS.
import { useEffect, useRef, useState } from 'react';
import { supabase, num, stamp } from './lib.js';


export function Putaway() {
  const [psku, setPsku] = useState(''); const [pal, setPal] = useState(null); const [loc, setLoc] = useState('');
  const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false); const [wait, setWait] = useState(null); const [log, setLog] = useState([]);
  const a = useRef(null); const b = useRef(null);
  const load = () => supabase.rpc('nexus_pallets', { p_org: null, p_q: null }).then(({ data }) => setWait((data || []).filter((r) => r.status === 'open' || r.status === 'counted')));
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);
  useEffect(() => { (pal ? b : a).current?.focus(); }, [pal]);
  const scanPallet = (e) => {
    e.preventDefault(); const code = psku.trim().toUpperCase().split('-C')[0]; if (!code) return;
    const p = (wait || []).find((r) => r.psku.toUpperCase() === code);
    if (!p) return setMsg({ kind: 'bad', text: `${code} is not waiting for put-away.` });
    if (p.held) return setMsg({ kind: 'bad', text: `${p.psku} is on HOLD. An admin must release it first.` });
    setMsg(null); setPal(p); setLoc('');
  };
  const scanLoc = async (e) => {
    e.preventDefault(); if (!loc.trim() || busy) return; setBusy(true);
    const { data, error } = await supabase.rpc('nexus_putaway', { p_psku: pal.psku, p_location: loc.trim() }); setBusy(false);
    if (error) { setLoc(''); return setMsg({ kind: 'bad', text: error.message }); }
    setLog((l) => [{ ...data, at: new Date().toISOString(), item: pal.item_name, brand: pal.org_name }, ...l].slice(0, 12));
    setMsg({ kind: 'ok', text: `${data.psku} is in ${data.location}. ${num(data.units_posted)} units are now in stock.` }); setPal(null); setPsku(''); setLoc(''); load();
  };
  const ready = (wait || []).filter((r) => !r.held); const held = (wait || []).filter((r) => r.held);
  return (
    <>
      <div className="head"><h1>Put-away</h1><div className="glance"><div><b className={ready.length ? 'hot' : ''}>{num(ready.length)}</b><small>Waiting</small></div><div><b>{num(held.length)}</b><small>On hold</small></div></div></div>
      {msg && <div className={`strip ${msg.kind}`} data-testid="putaway-msg">{msg.text}</div>}
      <div className="scanflow">
        <form onSubmit={scanPallet} className={pal ? 'done' : 'now'}><span>1</span><label>Scan the pallet label<input ref={a} data-testid="scan-pallet" value={pal ? pal.psku : psku} disabled={!!pal} onChange={(e) => setPsku(e.target.value)} placeholder="PSKU…" autoComplete="off" /></label>
          {pal && <div className="what"><b>{pal.org_name}</b> · {pal.item_name || 'Mixed pallet'} · {pal.cartons ?? '—'} cartons{pal.units_total ? ` · ${num(pal.units_total)} units` : ''} <button type="button" className="btn sm" onClick={() => { setPal(null); setPsku(''); }}>Change</button></div>}</form>
        <form onSubmit={scanLoc} className={pal ? 'now' : 'off'}><span>2</span><label>Scan the position code<input ref={b} data-testid="scan-position" value={loc} disabled={!pal || busy} onChange={(e) => setLoc(e.target.value)} placeholder="P-01… (from the pallet-jack sheet)" autoComplete="off" /></label></form>
      </div>
      <section><h2>Waiting for a position</h2>
        <table data-testid="putaway-table"><thead><tr><th>Pallet</th><th>Brand</th><th>Item</th><th className="n">Cartons</th><th className="n">Units</th><th>Received</th><th /></tr></thead>
          <tbody>{(wait || []).map((r) => <tr key={r.id}><td className="code">{r.psku}</td><td>{r.org_name}</td><td>{r.item_name}</td><td className="n">{r.cartons ?? '—'}</td><td className="n">{r.units_total ? num(r.units_total) : '—'}</td><td>{stamp(r.received_at)}</td>
            <td>{r.held ? <span className="pill held">On hold</span> : <button className="btn sm" onClick={() => { setMsg(null); setPal(r); setLoc(''); }}>Put away</button>}</td></tr>)}</tbody></table>
        {wait && wait.length === 0 && <div className="empty">Nothing is waiting. Every received pallet has a position.</div>}
      </section>
      {log.length > 0 && <section><h2>Put away this session</h2><table><tbody>{log.map((l) => <tr key={l.psku}><td className="code">{l.psku}</td><td>{l.brand}</td><td>{l.item}</td><td className="code">{l.location}</td><td className="n">{num(l.units_posted)} units</td><td>{stamp(l.at)}</td></tr>)}</tbody></table></section>}
    </>
  );
}
