// Labeling: the register of every label a connected WMS (or Nexus itself) has made, with what is printed on it.
// The label designer and Nexus-side printing rules come next; this page already holds the record and can print a copy.
import { useState } from 'react';
import JsBarcode from 'jsbarcode';
import { rpc, num, stamp } from './lib.js';
import { useRpc } from './hooks.js';
import { Msg } from './parts.jsx';
const KIND = { pallet: 'Pallet 4 × 6', carton: 'Carton', unit: 'Unit', position: 'Position 4 × 6' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const bars = (v, h = 70) => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); try { JsBarcode(svg, v, { format: 'CODE128', displayValue: false, margin: 0, height: h, width: 2 }); } catch { return ''; } svg.setAttribute('preserveAspectRatio', 'none'); svg.style.width = '100%'; svg.style.height = `${h}px`; return svg.outerHTML; };
// what Nexus holds for a label, drawn as a label
export const faceHtml = (l) => {
  const c = l.content || {}; const tags = [c.fba && 'FBA', c.mixed && 'MIXED', c.ncc && 'NCC'].filter(Boolean).join(' · ');
  if (l.kind === 'position') return `<div class="face"><h3>${esc(l.code)}</h3><p>${esc(c.zone || '')}</p>${bars(`LOC-${l.code}`)}<small>NEXUS · LOC-${esc(l.code)}</small></div>`;
  if (l.kind === 'carton') return `<div class="face small"><p>${esc(c.brand || l.brand)}</p><b>${esc(l.item || c.item || '')}</b>${bars(l.code, 44)}<small>${esc(l.code)} · carton ${esc(c.carton ?? '')} · ${esc(c.pallet || l.pallet || '')}${c.fba ? ' · FBA' : ''}</small></div>`;
  return `<div class="face"><p>${esc(c.brand || l.brand)}</p><h3>${esc(l.code)}</h3><b>${esc(l.item || c.item || '')}</b><p>${esc(l.item_no || '')}${c.cartons != null ? ` · ${esc(c.cartons)} cartons` : ''}${tags ? ` · ${tags}` : ''}</p>${bars(l.code)}<small>NEXUS · ${esc(c.reference || '')}</small></div>`;
};
const CSS = `body{margin:0;font-family:Arial,Helvetica,sans-serif}.face{width:4in;height:6in;padding:.3in;box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between;page-break-after:always}.face h3{font-size:.7in;margin:0;line-height:1}.face p{margin:0;font-size:.22in;font-weight:700;text-transform:uppercase}.face b{font-size:.26in}.face small{font-size:.14in}.face.small{width:2in;height:1in;padding:.06in}.face.small p,.face.small b{font-size:.1in}.face.small small{font-size:.07in}`;
export function printFaces(labels) {
  const small = labels.every((l) => l.kind === 'carton'); const w = window.open('', '_blank'); if (!w) return false;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Nexus labels</title><style>@page{size:${small ? '2in 1in' : '4in 6in'};margin:0}${CSS}</style></head><body>${labels.map(faceHtml).join('')}</body></html>`);
  w.document.close(); w.focus(); setTimeout(() => w.print(), 300); return true;
}
export function LabelTable({ rows, sel, onSel }) {
  return (
    <table data-testid="label-table"><thead><tr><th>Label</th><th>Kind</th><th>Brand</th><th>Item</th><th>Pallet</th><th>Position</th><th>Made</th><th>Made by</th><th>From</th><th className="n">Printed</th></tr></thead>
      <tbody>{rows.map((l) => <tr key={l.id} className={sel === l.id ? 'first' : ''} onClick={() => onSel?.(l)} style={onSel ? { cursor: 'pointer' } : undefined}>
        <td className="code">{l.code}</td><td>{KIND[l.kind]}</td><td>{l.brand || '—'}</td><td>{l.item || '—'}{l.item_no ? <span className="sm"> · {l.item_no}</span> : null}</td><td className="code">{l.kind === 'pallet' ? '' : l.pallet || ''}</td><td className="code">{l.kind === 'position' ? l.code : l.position || '—'}</td>
        <td>{stamp(l.made_at)}</td><td>{l.made_by || '—'}</td><td>{l.source}</td><td className="n" title={l.last_printed_at ? `last ${stamp(l.last_printed_at)}` : ''}>{l.prints ? `${l.prints}×` : 'Not printed'}</td></tr>)}</tbody></table>);
}
export default function Labels({ brands }) {
  const [org, setOrg] = useState(''); const [kind, setKind] = useState(''); const [q, setQ] = useState(''); const [sel, setSel] = useState(null); const [msg, setMsg] = useState(null);
  const [rows, err, reload] = useRpc('nexus_labels_list', { p_org: org || null, p_kind: kind || null, p_q: q || null }, [org, kind, q]);
  const [dash] = useRpc('nexus_dashboard', {}, []);
  const print = async (l) => { if (!printFaces([l])) return setMsg({ text: 'The print window did not open. Allow pop-ups for Nexus and press Print again.' }); try { await rpc('nexus_labels_printed', { p_kind: l.kind, p_codes: [l.code] }); reload(); } catch (x) { setMsg({ text: x.message }); } };
  return (
    <>
      <div className="head"><h1>Labeling</h1><div className="glance"><div><b>{num(dash?.labels_total)}</b><small>Labels on file</small></div><div><b>{num(dash?.labels_today)}</b><small>Made today</small></div></div></div>
      <div className="strip">Every pallet and carton label a WMS makes is written here the moment it is made. The label designer is the next piece of work on this page.</div>
      <div className="filters">
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">Every kind</option>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select aria-label="Brand" value={org} onChange={(e) => setOrg(e.target.value)}><option value="">All brands</option>{brands.map((b) => <option key={b.org_id} value={b.org_id}>{b.brand}</option>)}</select>
        <input aria-label="Search" placeholder="Label, pallet or item…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Msg m={msg || (err && { text: err })} />
      <div className={sel ? 'split' : ''}>
        <div>{rows && <LabelTable rows={rows} sel={sel?.id} onSel={setSel} />}{rows && rows.length === 0 && <div className="empty">No labels match.</div>}</div>
        {sel && <aside data-testid="label-detail"><h2>{KIND[sel.kind]} label</h2><div className="preview" dangerouslySetInnerHTML={{ __html: faceHtml(sel) }} />
          <p className="sm">Made {stamp(sel.made_at)}{sel.made_by ? ` by ${sel.made_by}` : ''} · from {sel.source} · printed {sel.prints}×</p>
          <div className="acts"><button className="btn primary" onClick={() => print(sel)}>Print a copy from Nexus</button><button className="btn" onClick={() => setSel(null)}>Close</button></div></aside>}
      </div>
    </>);
}
