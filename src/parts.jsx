import { useState } from 'react';
import { brandsOf, hueOf } from './FloorMap.jsx';
import { num } from './lib.js';
// Capacity ring: one arc per brand, the rest is free space. Percent full in the middle.
export function Ring({ m }) {
  const pal = m.positions.filter((p) => p.kind === 'pallet'); const total = pal.length || 1; const brands = brandsOf(m);
  const parts = brands.map((b) => ({ b, n: pal.filter((p) => p.pallets[0]?.brand === b).length })).filter((x) => x.n);
  const used = pal.filter((p) => p.pallets.length).length; const R = 54, C = 2 * Math.PI * R; let off = 0;
  return (
    <div className="ring" data-testid="ring">
      <svg viewBox="0 0 140 140" role="img" aria-label={`${used} of ${pal.length} pallet positions in use`}>
        <circle cx="70" cy="70" r={R} className="track" />
        {parts.map((x) => { const len = (x.n / total) * C; const el = <circle key={x.b} cx="70" cy="70" r={R} className="arc" style={{ '--h': hueOf(brands, x.b) }} strokeDasharray={`${Math.max(0, len - 1.5)} ${C}`} strokeDashoffset={-off} />; off += len; return el; })}
        <text x="70" y="68" className="pct">{Math.round((used / total) * 100)}%</text><text x="70" y="86" className="cap">FULL</text>
      </svg>
      <ul>{parts.map((x) => <li key={x.b}><i style={{ '--h': hueOf(brands, x.b) }} /><span>{x.b}</span><b>{x.n}</b></li>)}<li><i className="e" /><span>Free</span><b>{pal.length - used}</b></li><li className="tot"><span>Positions</span><b>{num(pal.length)}</b></li></ul>
    </div>);
}
export const Msg = ({ m }) => (m ? <div className={`strip ${m.kind || 'bad'}`} data-testid="msg">{m.text}</div> : null);
export const Pill = ({ p }) => <span className={`pill ${p.held ? 'held' : p.status}`}>{p.held ? 'On hold' : { open: 'Cartons to scan', counted: 'To put away', stored: 'Stored', void: 'Voided' }[p.status] || p.status}</span>;
const ACT = { move: 'Moved', putaway: 'Put away', edit: 'Details changed', void: 'Voided', position_edit: 'Position changed', position_add: 'Position added', received: 'Shipment fully received', pallet_received: 'Received', pallet_counted: 'Cartons counted', pallet_putaway: 'Put away', pallet_voided: 'Voided', pallet_hold: 'Put on hold', pallet_label_print: 'Label printed' };
const FIELD = { cartons: 'Cartons', units_total: 'Units', units_per_carton: 'Units per carton', item_name: 'Item', notes: 'Notes', reference: 'Reference', carrier: 'Carrier', fba: 'FBA', zone: 'Zone', active: 'In use', pallets: 'Pallets booked/received' };
export const what = (h) => {
  const a = ACT[h.action] || h.action; const where = h.from && h.to ? `${h.from} → ${h.to}` : h.to || h.from || '';
  const ch = h.changes ? Object.entries(h.changes).filter(([, v]) => JSON.stringify(v.from) !== JSON.stringify(v.to)).map(([k, v]) => `${FIELD[k] || k} ${v.from ?? '—'} → ${v.to ?? '—'}`).join(', ') : '';
  return [a, where, ch].filter(Boolean).join(' · ');
};
// Admin override of what a WMS entered for a pallet. Every change needs a reason and is written to the floor log.
export function PalletEditor({ p, onSave, onCancel }) {
  const init = { cartons: p.cartons ?? '', units_total: p.units_total ?? p.units ?? '', item_name: p.item_name ?? p.item ?? '', reference: p.reference ?? '', carrier: p.carrier ?? '', notes: p.notes ?? '', fba: !!p.fba };
  const [f, setF] = useState(init); const [why, setWhy] = useState(''); const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  // only the fields that were actually changed are sent, so nothing else on the pallet can be touched by accident
  const changed = Object.fromEntries(Object.keys(init).filter((k) => String(f[k]) !== String(init[k]) && !(['cartons', 'units_total'].includes(k) && f[k] === '')).map((k) => [k, ['cartons', 'units_total'].includes(k) ? Number(f[k]) : f[k]]));
  const save = (e) => { e.preventDefault(); onSave(changed, why); };
  return (
    <form className="editor" onSubmit={save} data-testid="pallet-editor">
      <label>Item<input value={f.item_name} onChange={set('item_name')} /></label>
      <div className="two"><label>Cartons<input type="number" min="0" value={f.cartons} onChange={set('cartons')} /></label><label>Units<input type="number" min="0" value={f.units_total} onChange={set('units_total')} /></label></div>
      <div className="two"><label>Reference<input value={f.reference} onChange={set('reference')} /></label><label>Carrier<input value={f.carrier} onChange={set('carrier')} /></label></div>
      <label>Notes<input value={f.notes} onChange={set('notes')} /></label>
      <label className="chk"><input type="checkbox" checked={f.fba} onChange={set('fba')} />FBA</label>
      <label>Why is this being changed?<input aria-label="Reason" value={why} onChange={(e) => setWhy(e.target.value)} required /></label>
      <div className="acts"><button className="btn primary" disabled={!Object.keys(changed).length}>Save override</button><button type="button" className="btn" onClick={onCancel}>Cancel</button></div>
    </form>);
}
