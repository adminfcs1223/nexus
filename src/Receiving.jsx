// Receiving, done in Nexus. Pick whose shipment it is, pick the booked shipment (what is in it comes from that brand's WMS),
// receive it pallet by pallet, print the labels from Nexus, put each pallet into a position, then complete it: that marks the
// booking received, which is how the brand's WMS knows it went through the whole receiving process.
import { useState } from 'react';
import { rpc, num, stamp, day } from './lib.js';
import { useRpc } from './hooks.js';
import { Msg, Pill } from './parts.jsx';
import { printFaces } from './Labels.jsx';
const newKey = () => `nexus-${crypto.randomUUID()}`;

export default function Receiving() {
  const [org, setOrg] = useState(null); const [open, setOpen] = useState(null);
  const [brands, err] = useRpc('nexus_receiving_brands', {}, [], 20000);
  const [ships, , reload] = useRpc(org ? 'nexus_receiving' : null, { p_org: org?.id }, [org?.id], 8000);
  const s = open && (ships || []).find((x) => x.id === open);
  if (org && s) return <Shipment org={org} s={s} reload={reload} back={() => setOpen(null)} />;
  return (
    <>
      <div className="head"><div>{org && <button className="back" onClick={() => setOrg(null)}>‹ Receiving</button>}<h1>{org ? org.name : 'Receiving'}</h1></div>
        <div className="glance"><div><b>{num((brands || []).reduce((a, b) => a + b.open, 0))}</b><small>Shipments to receive</small></div><div><b>{num((brands || []).reduce((a, b) => a + b.pallets, 0))}</b><small>Pallets expected</small></div></div></div>
      {err && <Msg m={{ text: err }} />}
      {!org && <><h2>Who is the shipment for?</h2><div className="tilesbig" data-testid="recv-brands">{(brands || []).map((b) => (
        <button key={b.id} disabled={!b.open} onClick={() => setOrg(b)}><b>{b.name}</b><span>{b.open ? `${b.open} shipment${b.open === 1 ? '' : 's'} · ${b.pallets} pallets · next ${day(`${b.next}T12:00`)}` : 'Nothing booked'}</span></button>))}</div>
        <p className="sm">A shipment shows here once it is on the calendar. What is in it comes from the brand's own WMS.</p></>}
      {org && <><h2>Which shipment?</h2>{(ships || []).map((x) => { const done = x.status === 'received' || x.status === 'discrepancy'; const stored = x.pallet_list.filter((p) => p.status === 'stored').length; return (
        <section key={x.id} className={`shiprow${done ? ' done' : ''}`} data-testid="recv-ship">
          <div className="row"><h3>{x.reference}</h3>{done ? <span className="pill stored">{x.status === 'received' ? 'Fully received' : 'Received with differences'}</span> : !x.approved ? <span className="pill counted">Not confirmed yet</span> : <button className="btn primary" onClick={() => setOpen(x.id)}>{x.pallet_list.length ? 'Continue receiving' : 'Receive'}</button>}</div>
          <div className="facts"><span>Expected<b>{x.expected_at ? day(`${x.expected_at}T12:00`) : '—'}</b></span><span>Pallets booked<b>{x.pallets}</b></span><span>Received so far<b>{x.pallet_list.length}</b></span><span>Put away<b>{stored}</b></span></div>
          <div className="sm">{x.lines.map((l) => `${num(l.qty)} × ${l.sku} ${l.name}`).join(' · ') || 'The WMS has not listed what is in this shipment.'}{x.origin ? ` · from ${x.origin}` : ''}{x.notes ? ` · ${x.notes}` : ''}</div>
        </section>); })}{ships && ships.length === 0 && <div className="empty">Nothing booked for {org.name}.</div>}</>}
    </>);
}

function Shipment({ org, s, reload, back }) {
  const [line, setLine] = useState(s.lines[0]?.sku_id || ''); const [cartons, setCartons] = useState(''); const [upc, setUpc] = useState(''); const [count, setCount] = useState(1); const [mode, setMode] = useState('partial'); const [hold, setHold] = useState('');
  const [key, setKey] = useState(newKey); const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false); const [psku, setPsku] = useState(''); const [loc, setLoc] = useState('');
  const done = s.status === 'received' || s.status === 'discrepancy'; const stored = s.pallet_list.filter((p) => p.status === 'stored').length; const waiting = s.pallet_list.filter((p) => p.status !== 'stored');
  const print = async (pskus) => {
    try { const all = []; for (const p of pskus) all.push(...(await rpc('nexus_labels_list', { p_org: org.id, p_kind: null, p_q: p, p_limit: 700 })).filter((l) => l.code === p || l.pallet === p));
      const pal = all.filter((l) => l.kind === 'pallet'), car = all.filter((l) => l.kind === 'carton').sort((a, b) => a.code.localeCompare(b.code));
      if (!printFaces(pal)) return setMsg({ text: 'The print window did not open. Allow pop-ups for Nexus and press Print again.' });
      await rpc('nexus_labels_printed', { p_kind: 'pallet', p_codes: pal.map((l) => l.code) });
      if (car.length && printFaces(car)) await rpc('nexus_labels_printed', { p_kind: 'carton', p_codes: car.map((l) => l.code) });
      reload();
    } catch (x) { setMsg({ text: x.message }); } };
  const receive = async (e) => {
    e.preventDefault(); setBusy(true); setMsg(null);
    try { const made = await rpc('wms_receive_booking', { p_inbound: s.id, p_org: org.id, p_lines: [{ sku: line, cartons: Number(cartons), units_per_carton: upc === '' ? null : Number(upc) }], p_pallets: Number(count), p_notes: null, p_key: key, p_mode: mode, p_hold_reason: mode === 'hold' ? hold : null });
      setMsg({ kind: 'ok', text: `${made.length} pallet${made.length === 1 ? '' : 's'} received: ${made.map((p) => p.psku).join(', ')}. Print the labels, then put ${made.length === 1 ? 'it' : 'them'} away.`, made: made.map((p) => p.psku) }); setKey(newKey()); setCartons(''); setCount(1); if (mode === 'hold') { setMode('partial'); setHold(''); } reload();
    } catch (x) { setMsg({ text: x.message }); } setBusy(false);
  };
  const put = async (e) => { e.preventDefault(); try { const r = await rpc('nexus_putaway', { p_psku: psku, p_location: loc }); setMsg({ kind: 'ok', text: `${r.psku} put away at ${r.location}.` }); setPsku(''); setLoc(''); reload(); } catch (x) { setMsg({ text: x.message }); } };
  const finish = async () => { try { const r = await rpc('nexus_receiving_finish', { p_inbound: s.id }); setMsg({ kind: 'ok', text: r.status === 'received' ? `${s.reference} is fully received: ${r.pallets} pallets. ${org.name}'s WMS now shows it as received.` : `${s.reference} is received with differences (${r.pallets} of ${r.pallets_booked} pallets, ${r.cartons} of ${r.cartons_booked} cartons). ${org.name}'s WMS shows the difference.` }); reload(); } catch (x) { setMsg({ text: x.message }); } };
  return (
    <>
      <div className="head"><div><button className="back" onClick={back}>‹ {org.name}</button><h1>{s.reference}</h1></div>
        <div className="glance"><div><b>{s.pallets}</b><small>Pallets booked</small></div><div><b>{s.pallet_list.length}</b><small>Received</small></div><div><b className={waiting.length ? 'hot' : ''}>{stored}</b><small>Put away</small></div></div></div>
      <Msg m={msg} />{msg?.made && <div className="acts" style={{ marginBottom: 16 }}><button className="btn primary" onClick={() => print(msg.made)}>Print labels for {msg.made.length === 1 ? msg.made[0] : `these ${msg.made.length} pallets`}</button></div>}
      {done && <div className="strip ok" data-testid="recv-done">{s.status === 'received' ? 'Fully received' : 'Received with differences'} · {stamp(s.received_at)}. {org.name}'s WMS has it.</div>}
      <div className="grid2">
        <div>
          {!done && !s.closed && <section><h2>1 · Receive a pallet</h2>
            <form className="editor" onSubmit={receive} data-testid="recv-form">
              <label>What is on the pallet<select aria-label="Product" value={line} onChange={(e) => setLine(e.target.value)} required>{s.lines.map((l) => <option key={l.sku_id} value={l.sku_id}>{l.sku} · {l.name} ({num(l.qty)} units booked)</option>)}</select></label>
              <div className="two"><label>Cartons on the pallet<input aria-label="Cartons" type="number" min="1" max="500" value={cartons} onChange={(e) => setCartons(e.target.value)} required /></label><label>Units per carton<input type="number" min="1" value={upc} onChange={(e) => setUpc(e.target.value)} /></label></div>
              <div className="two"><label>Pallets like this<input type="number" min="1" max="40" value={count} onChange={(e) => setCount(e.target.value)} required /></label>
                <label>After this<select aria-label="After this" value={mode} onChange={(e) => setMode(e.target.value)}><option value="partial">More of this shipment is still coming</option><option value="final">This is the last of this shipment</option><option value="hold">Put on HOLD (something is wrong)</option></select></label></div>
              {mode === 'hold' && <label>Why is it on HOLD?<input value={hold} onChange={(e) => setHold(e.target.value)} required /></label>}
              <div className="acts"><button className="btn primary" disabled={busy || !s.lines.length}>{busy ? 'Receiving…' : 'Receive'}</button></div>
              {!s.lines.length && <p className="sm">The brand's WMS has not listed what is in this shipment, so there is nothing to receive against yet.</p>}
            </form></section>}
          {!done && <section><h2>2 · Put away</h2>
            <form className="acts" onSubmit={put} data-testid="recv-put"><input aria-label="Pallet" placeholder="Scan pallet label" value={psku} onChange={(e) => setPsku(e.target.value)} /><input aria-label="Position" placeholder="Scan position label" value={loc} onChange={(e) => setLoc(e.target.value)} /><button className="btn primary" disabled={!psku.trim() || !loc.trim()}>Put away</button></form>
            <p className="sm">{waiting.length ? `${waiting.length} pallet${waiting.length === 1 ? '' : 's'} of this shipment still to put away.` : s.pallet_list.length ? 'Every pallet received so far is in a position.' : 'Nothing received yet.'}</p></section>}
          {!done && <section><h2>3 · Complete</h2><p className="sm">When the last pallet is received and all of them are in a position, complete the shipment. That tells {org.name}'s WMS it went through the whole receiving process.</p>
            <div className="acts"><button className="btn primary" onClick={finish} disabled={!s.closed || waiting.length > 0}>Complete receiving</button>{!s.closed && <span className="sm">Waiting for the last pallet</span>}{s.closed && waiting.length > 0 && <span className="sm">Waiting for put-away</span>}</div></section>}
        </div>
        <div>
          <section><h2>Booked by {org.name}'s WMS</h2><div className="facts wide"><span>Expected<b>{s.expected_at ? day(`${s.expected_at}T12:00`) : '—'}</b></span><span>Pallets<b>{s.pallets}</b></span><span>Cartons<b>{s.cartons || '—'}</b></span></div>
            {s.lines.map((l) => <div className="hist" key={l.sku_id}><b>{num(l.qty)} units</b> {l.sku}<span>{l.name}</span></div>)}{s.origin && <p className="sm">From {s.origin}</p>}{s.notes && <p className="sm">{s.notes}</p>}</section>
          <section><h2>Pallets received · {s.pallet_list.length}</h2>{s.pallet_list.map((p) => <div className="pal" key={p.psku} data-testid="recv-pallet"><div className="row"><button className="link code" onClick={() => setPsku(p.psku)}>{p.psku}</button><Pill p={p} /></div>
            <div className="sm">{p.item} · {p.cartons ?? '—'} cartons · {p.position ? `at ${p.position}` : 'no position yet'} · label printed {p.label_prints}×{p.held ? ` · HOLD: ${p.hold_reason}` : ''}</div>
            <button className="btn sm" onClick={() => print([p.psku])}>Print labels</button></div>)}{s.pallet_list.length === 0 && <p className="sm">None yet.</p>}</section>
        </div>
      </div>
    </>);
}
