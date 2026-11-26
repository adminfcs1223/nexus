// The live Nexus site: Calendar, Warehouse Map, Pallets. One read (lib.siteOverview) of the same Hillsborough records Souled
// and ShipBay use, asked again every 15 seconds and when the tab comes back. Nothing here writes, and nothing is kept locally.
import { useEffect, useRef, useState } from 'react';
import { siteOverview, stamp } from './lib.js';

const TABS = [['calendar', 'Calendar'], ['map', 'Warehouse Map'], ['pallets', 'Pallets']];
const COMPANY = { SOULED: 'Souled', SHIPBAY: 'ShipBay' };
const who = (c) => COMPANY[c] || 'Unknown';

function useOverview(load) {
  const [s, set] = useState({ data: null, error: null, at: null }); const live = useRef(true);
  useEffect(() => {
    live.current = true;
    const go = () => load().then((d) => live.current && set({ data: d, error: null, at: new Date() }), (e) => live.current && set((x) => ({ ...x, error: e.message || 'Nexus could not answer.' })));
    go(); const t = setInterval(go, 15000); const vis = () => { if (!document.hidden) go(); }; document.addEventListener('visibilitychange', vis);
    return () => { live.current = false; clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, []);
  return s;
}
// how one position is drawn: open (white), a company (blue / orange), both, out of use, or unknown (gray)
export function tone(p) {
  if (!p || !['open', 'blocked', 'unavailable'].includes(p.status)) return 'unknown';
  if (p.status !== 'open') return 'off';
  const cos = (p.occupants || []).map((o) => o.company);
  if (cos.length === 0) return p.used > 0 ? 'unknown' : 'open';
  if (cos.some((c) => !COMPANY[c])) return 'unknown';
  return cos.length > 1 ? 'both' : cos[0].toLowerCase();
}

export default function Site({ me, onSignOut, embed, load = siteOverview }) {
  const [tab, setTab] = useState('map'); const { data, error, at } = useOverview(load);
  const body = !data ? <div className="center" style={{ minHeight: 240 }}>{error ? <div className="strip bad">{error}</div> : 'Loading the warehouse…'}</div>
    : tab === 'calendar' ? <CalendarTab d={data} /> : tab === 'pallets' ? <PalletsTab d={data} /> : <MapTab d={data} />;
  const stale = data && error ? <div className="strip bad">Nexus did not answer just now. Showing what it last said{at ? ` at ${stamp(at)}` : ''}.</div> : null;
  if (embed) return <main className="embed">{stale}{data ? <MapTab d={data} /> : body}</main>;
  return (
    <div className="shell">
      <header className="top">
        <img src="/brand/nexus-logo.png" alt="Nexus" />
        <nav>{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</nav>
        <div className="who"><b>{me?.full_name || me?.email || 'Signed in'}</b><small>Hillsborough</small>{onSignOut && <button onClick={onSignOut}>Sign out</button>}</div>
      </header>
      <main>{stale}{body}</main>
    </div>
  );
}

function MapTab({ d }) {
  const [sel, setSel] = useState(null);
  const drawn = d.positions.filter((p) => p.x != null && p.y != null && (p.kind === 'pallet' || p.kind === 'staging'));
  const g = d.layout?.grid || { cols: 5, rows: 18 }; const walk = (d.layout?.blocks || []).find((b) => b.key === 'walkway');
  const mark = (k) => (d.landmarks || []).find((l) => l.key === k); const span = (m) => (m ? { gridColumn: `${m.x[0]} / ${m.x[1] + 1}` } : null);
  const n = (t) => drawn.filter((p) => tone(p) === t).length; const picked = sel && d.positions.find((p) => p.code === sel);
  const pallets = drawn.filter((p) => p.kind === 'pallet').length, staging = drawn.filter((p) => p.kind === 'staging').length;
  return (
    <>
      <div className="head"><h1>Warehouse Map</h1>
        <div className="glance"><div><b>{n('open')}</b><small>Open</small></div><div><b>{n('souled') + n('both')}</b><small>Souled</small></div><div><b>{n('shipbay') + n('both')}</b><small>ShipBay</small></div>{n('off') > 0 && <div><b>{n('off')}</b><small>Out of use</small></div>}{n('unknown') > 0 && <div><b className="hot">{n('unknown')}</b><small>Unknown</small></div>}</div>
      </div>
      <div className="hbwrap">
        <div className="hbfloor" style={{ '--cols': g.cols }}>
          <div className="hbedge top" style={{ gridTemplateColumns: `repeat(${g.cols}, 1fr)` }}>{mark('exit') && <span style={span(mark('exit'))}>Exit</span>}{mark('dock') && <span className="dock" style={span(mark('dock'))}>Receiving dock</span>}</div>
          <div className="hbcells" style={{ gridTemplateColumns: `repeat(${g.cols}, 1fr)`, gridTemplateRows: `repeat(${g.rows}, 30px)` }}>
            {walk && <div className="hbwalk" style={{ gridColumn: `${walk.x[0]} / ${walk.x[1] + 1}`, gridRow: `${walk.y[0]} / ${walk.y[1] + 1}` }}><span>Walkway</span></div>}
            {staging > 0 && <div className="hbstglabel" style={{ gridColumn: '4 / 6', gridRow: Math.min(...drawn.filter((p) => p.kind === 'staging').map((p) => p.y)) }}>Staging</div>}
            {mark('prep') && <div className="hbprep" style={{ ...span(mark('prep')), gridRow: `${g.rows - 1} / ${g.rows + 1}` }}>Prep area</div>}
            {drawn.map((p) => <button key={p.code} className={`hbtile hb-${tone(p)} ${p.kind === 'staging' ? 'hbstg' : ''} ${sel === p.code ? 'sel' : ''}`} style={{ gridColumn: p.x, gridRow: p.y }} onClick={() => setSel(sel === p.code ? null : p.code)} title={p.code}>{p.code}</button>)}
          </div>
          <div className="hbedge bottom" style={{ gridTemplateColumns: `repeat(${g.cols}, 1fr)` }}>{mark('entrance') && <span style={span(mark('entrance'))}>Entrance</span>}</div>
        </div>
        <aside className="hbside">
          <div className="hblegend"><span><i className="hb-open" />Open</span><span><i className="hb-souled" />Souled</span><span><i className="hb-shipbay" />ShipBay</span><span><i className="hb-off" />Blocked / not in use</span><span><i className="hb-unknown" />Unknown</span></div>
          {picked ? <Detail p={picked} /> : <p className="sm">Select a position to see its details.</p>}
          <p className="sm note">{pallets} pallet positions · {staging} staging · map version {d.map_version}</p>
        </aside>
      </div>
    </>
  );
}
function Detail({ p }) {
  const t = tone(p); const state = t === 'open' ? 'Open' : t === 'off' ? (p.status === 'blocked' ? 'Blocked' : 'Not in use') : t === 'unknown' ? 'Unknown' : 'Occupied';
  return (
    <section className="hbdetail">
      <h3>{p.code}</h3>
      <dl>
        <dt>Type</dt><dd>{p.kind === 'staging' ? 'Staging position' : 'Pallet position'}</dd>
        <dt>Status</dt><dd>{state}</dd>
        {t === 'off' && p.status_reason && <><dt>Reason</dt><dd>{p.status_reason}</dd></>}
        {(p.occupants || []).map((o) => <span key={o.company} style={{ display: 'contents' }}><dt>{who(o.company)}</dt><dd>{o.pallets} {o.pallets === 1 ? 'pallet' : 'pallets'} · since {stamp(o.since)}</dd></span>)}
        <dt>Capacity</dt><dd>{p.capacity == null ? 'No limit set' : `${p.capacity} ${p.capacity === 1 ? 'pallet' : 'pallets'}`}</dd>
      </dl>
      {t === 'open' && <p className="sm">Open in Nexus. Check the position on the floor before a pallet is recorded here.</p>}
    </section>
  );
}

function PalletsTab({ d }) {
  const rows = d.pallets || [];
  return (
    <>
      <div className="head"><h1>Pallets</h1><div className="glance"><div><b>{rows.length}</b><small>Registered</small></div></div></div>
      {rows.length === 0 ? <section><p className="sm" style={{ margin: 0 }}>No pallets are registered on the floor.</p></section> : (
        <table><thead><tr><th>Position</th><th>Company</th><th>Type</th><th>Placed</th></tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}><td className="code">{r.location}</td><td><span className={`hbco c-${COMPANY[r.company] ? r.company.toLowerCase() : 'unknown'}`}>{who(r.company)}</span></td><td>{r.kind === 'staging' ? 'Staging' : 'Pallet position'}</td><td>{stamp(r.since)}</td></tr>)}</tbody></table>
      )}
    </>
  );
}

function CalendarTab({ d }) {
  const ev = (d.calendar || []).filter((e) => e.status !== 'cancelled'); const today = new Date(); today.setHours(0, 0, 0, 0);
  const coming = ev.filter((e) => new Date(e.starts_at) >= today), past = ev.filter((e) => new Date(e.starts_at) < today).reverse();
  const dayOf = (e) => new Date(e.starts_at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const time = (e) => new Date(e.starts_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const List = ({ rows }) => { let last = null; return (
    <table><thead><tr><th>Day</th><th>Time</th><th>Direction</th><th>Company</th><th className="n">Pallets</th><th>Status</th></tr></thead>
      <tbody>{rows.map((e, i) => { const dy = dayOf(e); const show = dy !== last; last = dy; return <tr key={i}><td>{show ? dy : ''}</td><td>{time(e)}</td><td>{e.direction === 'inbound' ? 'Inbound' : 'Outbound'}</td><td><span className={`hbco c-${COMPANY[e.company] ? e.company.toLowerCase() : 'unknown'}`}>{who(e.company)}</span></td><td className="n">{e.pallets ?? '—'}</td><td>{e.status[0].toUpperCase() + e.status.slice(1)}</td></tr>; })}</tbody></table>); };
  return (
    <>
      <div className="head"><h1>Calendar</h1><div className="glance"><div><b>{coming.filter((e) => e.direction === 'inbound').length}</b><small>Inbound ahead</small></div><div><b>{coming.filter((e) => e.direction === 'outbound').length}</b><small>Outbound ahead</small></div></div></div>
      {coming.length === 0 ? <section><p className="sm" style={{ margin: 0 }}>No shipments are scheduled.</p></section> : <List rows={coming} />}
      {past.length > 0 && <><h2 className="sub" style={{ marginTop: 24 }}>Last 31 days</h2><List rows={past} /></>}
    </>
  );
}
