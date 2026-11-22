// Labeling: the register of every label a connected WMS (or Nexus itself) has made, with what is printed on it.
// The label designer and Nexus-side printing rules come next; this page already holds the record and can print a copy.
import { useState } from 'react';
import { useEffect } from 'react';
import { labelHtml, cartonLabelHtml, locationLabelHtml, cartonCodes, parseSize, getCartonSize, printPalletLabels, printCartonLabels, printLocationLabels } from './labels/label.js';
import { labelPallets, LabelView } from './Receiving.jsx';
import { rpc, num, stamp } from './lib.js';
import { useRpc } from './hooks.js';
import { Msg } from './parts.jsx';
const KIND = { pallet: 'Pallet 4 × 6', carton: 'Carton', unit: 'Unit', position: 'Position 4 × 6' };
// a label drawn from what the database holds: the pallet with its carton rows (pallet and carton labels), or the position
const face = (l, pallets) => { const p = pallets?.[0];
  if (l.kind === 'position') return { html: locationLabelHtml({ code: l.code, zone: l.content?.zone }), w: 4, h: 6 };
  if (!p) return null;
  if (l.kind === 'pallet') return { html: labelHtml(p, p.brand), w: 4, h: 6 };
  const c = cartonCodes(p).find((x) => x.code === l.code); const z = parseSize(getCartonSize()); return c ? { html: cartonLabelHtml(p, p.brand, c, z.key), w: z.w, h: z.h, seq: c.seq } : null; };
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
  const [pal, setPal] = useState(null);
  useEffect(() => { setPal(null); if (!sel || sel.kind === 'position' || !sel.pallet) return; let on = true; labelPallets([sel.pallet]).then((d) => on && setPal(d)).catch((x) => on && setMsg({ text: x.message })); return () => { on = false; }; }, [sel?.id]);
  const f = sel && face(sel, pal);
  const print = async (l) => {
    const ok = l.kind === 'position' ? await printLocationLabels([{ code: l.code, zone: l.content?.zone }], '4x6') : l.kind === 'pallet' ? await printPalletLabels(pal, (p) => p.brand) : await printCartonLabels(pal, (p) => p.brand, [f.seq]);
    if (!ok) return setMsg({ text: 'The print window did not open. Nothing was printed; press Print again.' });
    try { await rpc('nexus_labels_printed', { p_kind: l.kind, p_codes: [l.code] }); reload(); } catch (x) { setMsg({ text: x.message }); } };
  return (
    <>
      <div className="head"><h1>Labeling</h1><div className="glance"><div><b>{num(dash?.labels_total)}</b><small>Labels on file</small></div><div><b>{num(dash?.labels_today)}</b><small>Made today</small></div></div></div>
      <div className="strip">Nexus is the label source: every pallet, carton and position label is on file here and prints from here. The label designer is the next piece of work on this page.</div>
      <div className="filters">
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">Every kind</option>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select aria-label="Brand" value={org} onChange={(e) => setOrg(e.target.value)}><option value="">All brands</option>{brands.map((b) => <option key={b.org_id} value={b.org_id}>{b.brand}</option>)}</select>
        <input aria-label="Search" placeholder="Label, pallet or item…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Msg m={msg || (err && { text: err })} />
      <div className={sel ? 'split' : ''}>
        <div>{rows && <LabelTable rows={rows} sel={sel?.id} onSel={setSel} />}{rows && rows.length === 0 && <div className="empty">No labels match.</div>}</div>
        {sel && <aside data-testid="label-detail"><h2>{KIND[sel.kind]} label</h2>{f ? <div className="preview"><LabelView html={f.html} w={f.w} h={f.h} inch={Math.min(290 / f.w, 330 / f.h)} /></div> : <p className="sm">{sel.kind !== 'position' && !sel.pallet ? 'This label\'s pallet was voided.' : 'Reading the label…'}</p>}
          <p className="sm">Made {stamp(sel.made_at)}{sel.made_by ? ` by ${sel.made_by}` : ''} · from {sel.source} · printed {sel.prints}×</p>
          <div className="acts"><button className="btn primary" disabled={!f} onClick={() => print(sel)}>Print from Nexus</button><button className="btn" onClick={() => setSel(null)}>Close</button></div></aside>}
      </div>
    </>);
}
