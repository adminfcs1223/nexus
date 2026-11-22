// Floor: the one place that controls the warehouse floor. Every position and what stands on it, moving a pallet, overriding
// what a WMS entered, adding and changing positions, position labels, and the log of every floor change.
import { useState } from 'react';
import { rpc, num, stamp, day } from './lib.js';
import { useRpc } from './hooks.js';
import FloorMap, { Legend, capacity } from './FloorMap.jsx';
import { Msg, Pill, PalletEditor, what } from './parts.jsx';
import { printPositionLabels, printJackSheet, expandCodes } from './positions.js';

export default function Floor({ me, openPallet }) {
  const admin = me.role === 'shipbay_admin'; const canMove = admin || me.role === 'shipbay_staff';
  const [m, err, reload] = useRpc('nexus_map', {}, [], 10000);
  const [sel, setSel] = useState(null); const [moving, setMoving] = useState(null); const [why, setWhy] = useState(''); const [editing, setEditing] = useState(null); const [msg, setMsg] = useState(null);
  const [pos, , reloadPos] = useRpc(sel ? 'nexus_position_detail' : null, { p_code: sel }, [sel], 10000);
  const [log, , reloadLog] = useRpc('nexus_floor_log', { p_limit: 60 }, [], 20000);
  const [off, , reloadOff] = useRpc(admin ? 'nexus_positions_off' : null, {}, [], 60000);
  const [codes, setCodes] = useState(''); const [zone, setZone] = useState('bulk'); const [newZone, setNewZone] = useState(null);
  const again = () => { reload(); reloadPos(); reloadLog(); reloadOff(); };
  const run = async (fn, okText) => { try { const r = await fn(); setMsg({ kind: 'ok', text: typeof okText === 'function' ? okText(r) : okText }); again(); return true; } catch (x) { setMsg({ text: x.message }); return false; } };
  if (err && !m) return <Msg m={{ text: `Nexus could not be read (${err}).` }} />;
  if (!m) return <div className="empty">Loading…</div>;
  const cap = capacity(m);
  const pick = async (code) => {
    if (!moving) { setSel(sel === code ? null : code); setEditing(null); setNewZone(null); return; }
    if (await run(() => rpc('nexus_move_pallet', { p_psku: moving.psku, p_location: code, p_reason: why || null, p_store: !!moving.store }), (r) => `${r.psku} ${moving.store ? 'put away at' : 'moved to'} ${r.to}${r.from ? ` (was ${r.from})` : ''}.`)) { setMoving(null); setWhy(''); setSel(code); }
  };
  const print = async (rows) => { if (!(await printPositionLabels(rows))) return setMsg({ text: 'The print window did not open. Nothing was printed; press Print again.' }); try { await rpc('nexus_labels_printed', { p_kind: 'position', p_codes: rows.map((r) => r.code) }); again(); } catch { /* the label still printed */ } };
  const add = async (e) => { e.preventDefault(); let list; try { list = expandCodes(codes); } catch (x) { return setMsg({ text: x.message }); }
    if (await run(() => rpc('nexus_positions_add', { p_codes: list, p_zone: zone, p_kind: list.every((c) => c.startsWith('STG')) ? 'floor' : 'pallet' }), (n) => `${n} position${n === 1 ? '' : 's'} added.`)) setCodes(''); };
  const PalletCard = ({ x }) => (
    <div className="pal" data-testid="pos-pallet">
      <div className="row"><button className="link code" onClick={() => openPallet(x.psku)}>{x.psku}</button><Pill p={x} /></div>
      <div><b>{x.brand}</b> · {x.item || '—'}{x.item_no ? <span className="sm"> · {x.item_no}</span> : null}</div>
      <div className="facts"><span>Cartons<b>{x.cartons ?? '—'}</b></span><span>Units<b>{x.units ?? '—'}</b></span><span>On hand<b>{num(x.on_hand)}</b></span><span>Age<b>{x.age_days}d</b></span></div>
      <div className="sm">Received {stamp(x.received_at)}{x.stored_at ? ` · put away ${stamp(x.stored_at)}` : ''}</div>
      <div className="sm">Pallet label printed {x.label_prints}×{x.last_printed_at ? ` (last ${stamp(x.last_printed_at)})` : ''} · {x.carton_labels} carton labels on file</div>
      {editing === x.psku ? <PalletEditor p={x} onCancel={() => setEditing(null)} onSave={async (c, r) => { if (await run(() => rpc('nexus_pallet_edit', { p_psku: x.psku, p_changes: c, p_reason: r }), `${x.psku} updated. The WMS shows the new details.`)) setEditing(null); }} />
        : <div className="acts">{canMove && <button className="btn sm primary" onClick={() => { setMoving({ psku: x.psku, from: sel }); setMsg(null); }}>Move</button>}{admin && <button className="btn sm" onClick={() => setEditing(x.psku)}>Override details</button>}<button className="btn sm" onClick={() => openPallet(x.psku)}>Everything on this pallet</button></div>}
    </div>);
  return (
    <>
      <div className="head"><h1>Floor</h1><div className="glance"><div><b>{cap.used}</b><small>Positions in use</small></div><div><b>{cap.free}</b><small>Free</small></div><div><b className={m.unplaced.length ? 'hot' : ''}>{m.unplaced.length}</b><small>Waiting for a position</small></div><div><b>{off?.length ?? 0}</b><small>Turned off</small></div></div></div>
      {moving && <div className="strip move" data-testid="moving"><b>{moving.store ? 'Putting away' : 'Moving'} {moving.psku}{moving.from ? ` from ${moving.from}` : ''}.</b> Click the free position it goes to.
        <input aria-label="Move reason" placeholder="Reason (optional)" value={why} onChange={(e) => setWhy(e.target.value)} /><button className="btn sm" onClick={() => { setMoving(null); setWhy(''); }}>Cancel</button></div>}
      <Msg m={msg} />
      <div className="floor">
        <div><FloorMap m={m} sel={sel} onSel={pick} target={!!moving} /><Legend m={m} /><p className="sm">Live · {stamp(m.as_of)} · a scan in any connected WMS shows here within seconds</p></div>
        <aside>
          {!sel && <section><h2>Positions</h2><p className="sm">Click any position to see what stands there, its labels and its history.</p></section>}
          {sel && pos && <section data-testid="cell-detail">
            <div className="row"><h2>Position {pos.code}</h2><button className="btn sm" onClick={() => print([pos])}>Print label</button></div>
            <div className="facts"><span>Zone<b>{pos.zone || '—'}</b></span><span>Kind<b>{pos.kind === 'pallet' ? 'Pallet position' : 'Floor spot'}</b></span><span>Label printed<b>{pos.label?.prints ?? 0}×</b></span><span>Added<b>{day(pos.created_at)}</b></span></div>
            {admin && (newZone === null ? <div className="acts"><button className="btn sm" onClick={() => setNewZone(pos.zone || '')}>Change zone</button><button className="btn sm" disabled={pos.pallets.length > 0} title={pos.pallets.length ? 'Move the pallet off first' : ''} onClick={async () => { if (await run(() => rpc('nexus_position_edit', { p_code: pos.code, p_zone: pos.zone, p_active: false }), `${pos.code} turned off. It is off the map and can be turned back on below.`)) setSel(null); }}>Turn off</button></div>
              : <form className="acts" onSubmit={async (e) => { e.preventDefault(); if (await run(() => rpc('nexus_position_edit', { p_code: pos.code, p_zone: newZone, p_active: true }), `${pos.code} is now in zone ${newZone || '—'}.`)) setNewZone(null); }}><input aria-label="Position zone" value={newZone} onChange={(e) => setNewZone(e.target.value)} /><button className="btn sm primary">Save zone</button><button type="button" className="btn sm" onClick={() => setNewZone(null)}>Cancel</button></form>)}
            {pos.pallets.length === 0 ? <p className="sm">Free. Nothing stands here.</p> : pos.pallets.map((x) => <PalletCard key={x.psku} x={x} />)}
            {pos.history.length > 0 && <><h2 className="sub">History of this position</h2>{pos.history.slice(0, 8).map((h, i) => <div className="hist" key={i}><b>{h.psku || pos.code}</b> {what(h)}<span>{stamp(h.at)} · {h.by || h.source}{h.reason ? ` · “${h.reason}”` : ''}</span></div>)}</>}
          </section>}
          {m.unplaced.length > 0 && <section data-testid="unplaced"><h2>Received, no position yet · {m.unplaced.length}</h2>{m.unplaced.slice(0, 12).map((x) => (
            <div className="pal" key={x.psku}><div className="row"><button className="link code" onClick={() => openPallet(x.psku)}>{x.psku}</button><Pill p={x} /></div><div className="sm">{x.brand} · {x.item || '—'} · {stamp(x.received_at)}</div>
              {canMove && !x.held && <button className="btn sm primary" onClick={() => { setMoving({ psku: x.psku, store: true }); setMsg(null); }}>Put away on the map</button>}</div>))}</section>}
          <section data-testid="position-controls"><h2>Position labels and new positions</h2>
            <div className="acts"><button className="btn primary" data-testid="jack-sheet" onClick={async () => { if (!(await printJackSheet(m.positions.filter((p) => p.kind !== 'dock')))) setMsg({ text: 'The print window did not open. Nothing was printed; press Print again.' }); }}>Print the pallet-jack scan sheet</button><button className="btn" onClick={() => print(m.positions.filter((p) => p.kind === 'pallet'))}>Print all 4 × 6 position labels</button></div>
            <p className="sm">The scan sheet is every position's code and barcode on letter paper, for the pallet jacks: scan the pallet label, then its spot on the sheet.</p>
            {admin && <form className="acts" onSubmit={add}><input aria-label="New positions" placeholder="P-73..P-80 or STG-03" value={codes} onChange={(e) => setCodes(e.target.value)} /><input aria-label="Zone" placeholder="Zone" value={zone} onChange={(e) => setZone(e.target.value)} style={{ width: 110 }} /><button className="btn primary" disabled={!codes.trim()}>Add positions</button></form>}
            {admin && off?.length > 0 && <><h2 className="sub">Turned off</h2><div className="acts">{off.map((o) => <button key={o.code} className="btn sm" onClick={() => run(() => rpc('nexus_position_edit', { p_code: o.code, p_zone: o.zone, p_active: true }), `${o.code} is back on the map.`)}>Turn {o.code} back on</button>)}</div></>}
          </section>
        </aside>
      </div>
      <section><h2>Floor log</h2>
        <table data-testid="floor-log"><thead><tr><th>When</th><th>Pallet</th><th>Brand</th><th>What happened</th><th>Reason</th><th>By</th><th>Through</th></tr></thead>
          <tbody>{(log || []).map((h, i) => <tr key={i}><td>{stamp(h.at)}</td><td className="code">{h.psku ? <button className="link code" onClick={() => openPallet(h.psku)}>{h.psku}</button> : '—'}</td><td>{h.brand || '—'}</td><td>{what(h)}</td><td>{h.reason || ''}</td><td>{h.by || '—'}</td><td>{h.source}</td></tr>)}</tbody></table>
        {log && log.length === 0 && <div className="empty">Nothing has moved yet.</div>}</section>
    </>);
}
