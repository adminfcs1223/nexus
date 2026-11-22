// Incoming-shipment calendar. One month at a time. `api` decides who is asking: staff screens (login) or an admin window (key).
import { useEffect, useState } from 'react';
import { rpc, iso, num } from './lib.js';
import { Msg } from './parts.jsx';
export const staffApi = {
  shipments: (a, b) => rpc('nexus_shipments', { p_from: a, p_to: b }), brands: () => rpc('nexus_brands'),
  save: (s) => (s.id ? rpc('nexus_shipment_update', { p_id: s.id, p_expected: s.expected_at, p_pallets: Number(s.pallets), p_cartons: Number(s.cartons || 0), p_origin: s.origin || null, p_notes: s.notes || null, p_cancel: !!s.cancel })
    : rpc('nexus_shipment_create', { p_org: s.org_id, p_reference: s.reference, p_origin: s.origin || null, p_expected: s.expected_at, p_pallets: Number(s.pallets), p_cartons: Number(s.cartons || 0), p_notes: s.notes || null, p_lines: [] })),
};
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const grid = (y, m) => { const first = new Date(y, m, 1); const start = new Date(y, m, 1 - first.getDay()); return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)); };

export function useMonth(api, tick = 0) {
  const now = new Date(); const [ym, setYm] = useState([now.getFullYear(), now.getMonth()]); const [rows, setRows] = useState(null); const [err, setErr] = useState(null);
  const days = grid(ym[0], ym[1]);
  const load = () => api.shipments(iso(days[0]), iso(days[41])).then((d) => { setRows(d || []); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [ym[0], ym[1], tick]);
  return { ym, days, rows, err, load, step: (n) => setYm(([y, m]) => { const d = new Date(y, m + n, 1); return [d.getFullYear(), d.getMonth()]; }), title: new Date(ym[0], ym[1], 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) };
}
export function MonthGrid({ cal, sel, onDay, mini }) {
  const today = iso(new Date()); const by = {}; (cal.rows || []).forEach((s) => { (by[s.expected_at] ||= []).push(s); });
  return (
    <div className={`cal${mini ? ' mini' : ''}`} data-testid="calendar">
      <div className="calhead"><button className="btn sm" aria-label="Previous month" onClick={() => cal.step(-1)}>‹</button><b>{cal.title}</b><button className="btn sm" aria-label="Next month" onClick={() => cal.step(1)}>›</button></div>
      <div className="dow">{DOW.map((d) => <span key={d}>{mini ? d[0] : d}</span>)}</div>
      <div className="days">{cal.days.map((d) => { const k = iso(d); const list = by[k] || []; const pal = list.reduce((a, s) => a + s.pallets, 0);
        return (
          <button key={k} className={`d${d.getMonth() !== cal.ym[1] ? ' out' : ''}${k === today ? ' today' : ''}${sel === k ? ' on' : ''}${list.length ? ' has' : ''}`} onClick={() => onDay?.(k)} data-testid={`day-${k}`}
            title={list.map((s) => `${s.brand}: ${s.reference} (${s.pallets} pallets)`).join('\n')}>
            <span>{d.getDate()}</span>
            {mini ? (pal > 0 && <em>{pal}</em>) : list.slice(0, 3).map((s) => <div key={s.id} className={`ship${s.approved ? '' : ' wait'}${s.received_pallets >= s.pallets ? ' done' : ''}`}><b>{s.pallets}</b> {s.brand}</div>)}
            {!mini && list.length > 3 && <div className="more">+{list.length - 3} more</div>}
          </button>); })}</div>
    </div>);
}
export function nextDays(rows, n = 7) { const a = iso(new Date()); const e = new Date(); e.setDate(e.getDate() + n); const b = iso(e); return (rows || []).filter((s) => s.expected_at >= a && s.expected_at <= b); }

// Full calendar page: month, the picked day's shipments, and a form to book or change one.
export default function CalendarPage({ api, canEdit, brands: given, note }) {
  const [tick, setTick] = useState(0); const cal = useMonth(api, tick); const [sel, setSel] = useState(iso(new Date())); const [form, setForm] = useState(null); const [msg, setMsg] = useState(null); const [brands, setBrands] = useState(given || []);
  useEffect(() => { if (!given && api.brands) api.brands().then(setBrands).catch(() => {}); }, []);
  const list = (cal.rows || []).filter((s) => s.expected_at === sel);
  const open = (s) => { setMsg(null); setForm(s ? { ...s } : { org_id: brands[0]?.id || '', reference: '', origin: '', expected_at: sel, pallets: 1, cartons: 0, notes: '' }); };
  const save = async (e, cancel) => { e?.preventDefault(); try { await api.save({ ...form, cancel }); setForm(null); setMsg({ kind: 'ok', text: cancel ? 'Shipment cancelled.' : 'Saved to the calendar.' }); setTick(tick + 1); } catch (x) { setMsg({ text: x.message }); } };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const tot = (cal.rows || []).filter((s) => new Date(`${s.expected_at}T12:00`).getMonth() === cal.ym[1]);
  return (
    <>
      <div className="head"><h1>Calendar</h1><div className="glance"><div><b>{num(tot.length)}</b><small>Shipments this month</small></div><div><b>{num(tot.reduce((a, s) => a + s.pallets, 0))}</b><small>Pallets expected</small></div><div><b className={nextDays(cal.rows).length ? 'hot' : ''}>{num(nextDays(cal.rows).reduce((a, s) => a + s.pallets, 0))}</b><small>Pallets next 7 days</small></div></div></div>
      {cal.err && <Msg m={{ text: cal.err }} />}
      <div className="calwrap">
        <MonthGrid cal={cal} sel={sel} onDay={(k) => { setSel(k); setForm(null); }} />
        <aside>
          <h2>{new Date(`${sel}T12:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
          <Msg m={msg} />
          {!form && list.length === 0 && <p className="sm">Nothing booked for this day.</p>}
          {!form && list.map((s) => (
            <div className="pal" key={s.id} data-testid="ship-row"><b>{s.brand}</b> · {s.reference}{!s.approved && <span className="pill counted">Waiting for Nexus to confirm</span>}
              <div className="sm">{s.pallets} pallets{s.cartons ? ` · ${s.cartons} cartons` : ''}{s.origin ? ` · from ${s.origin}` : ''} · {s.received_pallets} received</div>
              {s.notes && <div className="sm">{s.notes}</div>}{(s.lines || []).map((l) => <div className="sm" key={l.sku}>{l.qty} × {l.sku} {l.name}</div>)}
              {canEdit && <button className="btn sm" onClick={() => open(s)}>Change</button>}</div>))}
          {canEdit && !form && <button className="btn primary" onClick={() => open(null)} disabled={!brands.length}>Book a shipment for this day</button>}
          {form && <form className="editor" onSubmit={save} data-testid="ship-form">
            {form.id ? <p className="sm"><b>{form.brand}</b> · {form.reference}</p> : <>
              <label>Brand<select value={form.org_id} onChange={set('org_id')}>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
              <label>Reference<input aria-label="Reference" value={form.reference} onChange={set('reference')} required placeholder="PO, volume, or what it is" /></label></>}
            <div className="two"><label>Expected<input type="date" value={form.expected_at} onChange={set('expected_at')} required /></label><label>Pallets<input type="number" min="1" max="200" value={form.pallets} onChange={set('pallets')} required /></label></div>
            <div className="two"><label>Cartons<input type="number" min="0" value={form.cartons} onChange={set('cartons')} /></label><label>Coming from<input value={form.origin || ''} onChange={set('origin')} /></label></div>
            <label>Notes<input value={form.notes || ''} onChange={set('notes')} /></label>
            <div className="acts"><button className="btn primary">{form.id ? 'Save changes' : 'Book it'}</button><button type="button" className="btn" onClick={() => setForm(null)}>Back</button>
              {form.id && <button type="button" className="btn danger" onClick={() => save(null, true)}>Cancel shipment</button>}</div>
          </form>}
          {note && <p className="sm note">{note}</p>}
        </aside>
      </div>
    </>);
}
