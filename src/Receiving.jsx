// Receiving, done in Nexus. Pick whose shipment it is, pick the booked shipment (what is in it comes from that brand's WMS),
// receive it pallet by pallet, print the labels (Nexus is the label source), put each pallet into a position, then complete
// it: that marks the booking received, which is how the brand's WMS knows it went through the whole receiving process.
// The form carries the ShipBay WMS receiving tools: one product or a mixed pallet, FBA, NCC (no carton count), a product
// that is not on the list, several pallets alike, HOLD, carton labels before Receive, roll size and direction, a test label.
// Receiving itself runs on the WMS's own database functions (wms_receive_booking, wms_hold_pskus): one request key = one receipt.
import { useEffect, useMemo, useState } from 'react';
import { supabase, rpc, num, stamp, day } from './lib.js';
import { useRpc } from './hooks.js';
import { Msg, Pill } from './parts.jsx';
import { printPalletLabels, printCartonLabels, labelHtml, cartonLabelHtml, cartonCodes, firstLabelled, linesOf, sizeLabel, parseSize, CARTON_SIZES, CARTON_TURNS, getCartonSize, setCartonSize, getCartonTurn, setCartonTurn } from './labels/label.js';
import { attachCartons, sameLabels } from './labels/cartons.js';

let lineId = 0;
const newLine = (sku = '') => ({ id: ++lineId, sku, off: false, what: '', cartons: '', upc: '', fba: false, cle: false });
const lineCartons = (l) => (l.cle || l.cartons === '' ? 0 : Math.max(0, Math.min(500, Math.round(Number(l.cartons) || 0))));
const FLIGHT = 'nexus-inflight';   // a Receive that was sent and has no answer yet: kept on this station so it is never lost or entered twice
const loadFlight = () => { try { const f = JSON.parse(localStorage.getItem(FLIGHT) || 'null'); return f && f.key && f.payload?.p_key === f.key ? f : null; } catch { return null; } };
const saveFlight = (f) => { try { f ? localStorage.setItem(FLIGHT, JSON.stringify(f)) : localStorage.removeItem(FLIGHT); return true; } catch { return false; } };
/** The pallets as the database holds them, with their checked carton rows: the only thing a label is printed from. */
export async function labelPallets(pskus) { const rows = await rpc('nexus_label_pallets', { p_pskus: pskus }); const got = attachCartons(rows, rows.flatMap((p) => p._cartons)); if (!got.ok) throw new Error(`The carton list for ${got.problems[0].psku || 'a pallet'} does not add up (${got.problems[0].problems[0]}). Nothing was printed.`); return got.pallets; }
export const LabelView = ({ html, w, h, inch }) => <div className="labelview" style={{ '--u': `${inch}px`, width: inch * w, height: inch * h }} dangerouslySetInnerHTML={{ __html: html }} />;

export default function Receiving({ me }) {
  const [org, setOrg] = useState(null); const [open, setOpen] = useState(() => loadFlight()?.inbound || null);
  const [brands, err] = useRpc('nexus_receiving_brands', {}, [], 20000);
  const flight = loadFlight(); const active = org || (flight && (brands || []).find((b) => b.id === flight.payload.p_org)) || null;   // an unsettled Receive brings its shipment back up
  const [ships, , reload] = useRpc(active ? 'nexus_receiving' : null, { p_org: active?.id }, [active?.id], 8000);
  const s = open && (ships || []).find((x) => x.id === open);
  if (active && s) return <Shipment me={me} org={active} s={s} reload={reload} back={() => { setOpen(null); setOrg(active); }} />;
  return (
    <>
      <div className="head"><div>{active && <button className="back" onClick={() => setOrg(null)}>‹ Receiving</button>}<h1>{active ? active.name : 'Receiving'}</h1></div>
        <div className="glance"><div><b>{num((brands || []).reduce((a, b) => a + b.open, 0))}</b><small>Shipments to receive</small></div><div><b>{num((brands || []).reduce((a, b) => a + b.pallets, 0))}</b><small>Pallets expected</small></div></div></div>
      {err && <Msg m={{ text: err }} />}
      {!active && <><h2>Who is the shipment for?</h2><div className="tilesbig" data-testid="recv-brands">{(brands || []).map((b) => (
        <button key={b.id} disabled={!b.open} onClick={() => setOrg(b)}><b>{b.name}</b><span>{b.open ? `${b.open} shipment${b.open === 1 ? '' : 's'} · ${b.pallets} pallets · next ${day(`${b.next}T12:00`)}` : 'Nothing booked'}</span></button>))}</div>
        <p className="sm">A shipment shows here once it is on the calendar. What is in it comes from the brand's own WMS.</p></>}
      {active && <><h2>Which shipment?</h2>{(ships || []).map((x) => { const done = x.status === 'received' || x.status === 'discrepancy'; const stored = x.pallet_list.filter((p) => p.status === 'stored').length; return (
        <section key={x.id} className={`shiprow${done ? ' done' : ''}`} data-testid="recv-ship">
          <div className="row"><h3>{x.reference}</h3>{done ? <span className="pill stored">{x.status === 'received' ? 'Fully received' : 'Received with differences'}</span> : !x.approved ? <span className="pill counted">Not confirmed yet</span> : <button className="btn primary" onClick={() => setOpen(x.id)}>{x.pallet_list.length ? 'Continue receiving' : 'Receive'}</button>}</div>
          <div className="facts"><span>Expected<b>{x.expected_at ? day(`${x.expected_at}T12:00`) : '—'}</b></span><span>Pallets booked<b>{x.pallets}</b></span><span>Received so far<b>{x.pallet_list.length}</b></span><span>Put away<b>{stored}</b></span></div>
          <div className="sm">{x.lines.map((l) => `${num(l.qty)} × ${l.sku} ${l.name}`).join(' · ') || 'The WMS has not listed what is in this shipment.'}{x.origin ? ` · from ${x.origin}` : ''}{x.notes ? ` · ${x.notes}` : ''}</div>
        </section>); })}{ships && ships.length === 0 && <div className="empty">Nothing booked for {active.name}.</div>}</>}
    </>);
}

function Shipment({ me, org, s, reload, back }) {
  const [products, setProducts] = useState(null); const [lines, setLines] = useState(() => [newLine(s.lines[0]?.sku_id || '')]); const [count, setCount] = useState(1); const [mode, setMode] = useState('partial'); const [holdWhy, setHoldWhy] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID()); const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false); const [sent, setSent] = useState(() => { const f = loadFlight(); return f && f.inbound === s.id ? f : null; });
  const [hold, setHold] = useState(null);   // carton labels printed before Receive: { pskus, sig, full }
  const [made, setMade] = useState(null); const [printed, setPrinted] = useState({}); const [psku, setPsku] = useState(''); const [loc, setLoc] = useState('');
  const [csize, setCs] = useState(getCartonSize); const [cturn, setCt] = useState(getCartonTurn);
  useEffect(() => { let on = true; rpc('wms_products', { p_org: org.id }).then((d) => on && setProducts(d || [])).catch((x) => on && (setProducts([]), setMsg({ text: x.message }))); return () => { on = false; }; }, [org.id]);
  const booked = new Set(s.lines.map((l) => l.sku_id)); const prodOf = (id) => (products || []).find((p) => p.id === id) || (s.lines.find((l) => l.sku_id === id) && { id, sku: s.lines.find((l) => l.sku_id === id).sku, name: s.lines.find((l) => l.sku_id === id).name });
  const setLine = (id, patch) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const done = s.status === 'received' || s.status === 'discrepancy'; const stored = s.pallet_list.filter((p) => p.status === 'stored').length; const waiting = s.pallet_list.filter((p) => p.status !== 'stored');
  const mixed = lines.length > 1; const n = Math.max(1, Math.min(60, Number(count) || 1)); const total = lines.reduce((a, l) => a + lineCartons(l), 0); const rows = total + lines.filter((l) => l.cle).length;
  const ready = (l) => !!(l.sku || (l.off && l.what.trim()));
  const problem = mode === 'hold' && !holdWhy.trim() ? 'Say why it is on HOLD' : !lines.every(ready) ? (mixed ? 'Pick every product' : 'Pick the product') : mixed && lines.some((l) => !l.cle && !lineCartons(l)) ? 'Every product needs its carton count, or NCC' : !mixed && !lines[0].cle && !lineCartons(lines[0]) ? 'Enter the cartons on the pallet, or NCC' : lines.some((l) => !l.cle && lineCartons(l) > 0 && !(Number(l.upc) >= 1)) ? 'Enter the units per carton' : total > 500 ? 'Up to 500 cartons on a pallet' : null;
  const sig = JSON.stringify([n, lines.map((l) => [l.sku || l.what.trim(), lineCartons(l), l.upc, l.fba, !!l.cle])]); const stale = !!hold && hold.sig !== sig; const locked = busy || !!sent;
  // the pallets as they will be received, cartons numbered the way the database numbers them (wms_receive)
  const draft = (pskus) => { const w = Math.max(2, String(rows).length); const one = lines[0];
    return pskus.map((ps, i) => { const no = ps.replace(/\D/g, '') || '000000'; let seq = 0; const cs = [];
      lines.forEach((l) => { const pr = prodOf(l.sku); for (let g = 0; g < (l.cle ? 1 : lineCartons(l)); g++) { seq += 1; cs.push({ seq, code: `C${no}${String(seq).padStart(w, '0')}`, item_no: pr?.sku || null, item_name: pr?.name || l.what.trim(), units_per_carton: l.upc === '' ? null : Number(l.upc), fba: l.fba, cle: !!l.cle }); } });
      const p1 = prodOf(one.sku);
      return { psku: ps, org_id: org.id, batch_pos: i + 1, batch_size: pskus.length, received_at: new Date().toISOString(), mixed, fba: lines.every((l) => l.fba), cle: lines.every((l) => l.cle), cartons: total || null, units_per_carton: !mixed && one.upc !== '' && !one.cle ? Number(one.upc) : null, item_no: mixed ? null : p1?.sku, item_name: mixed ? `Mixed pallet · ${lines.length} products` : p1?.name || one.what, received_by_name: me?.full_name || me?.email, _cartons: cs, _draft: true }; }); };
  const sample = useMemo(() => draft([hold?.pskus[0] || 'PSKU-______'])[0], [sig, hold, products]);
  const payload = () => ({ p_inbound: s.id, p_org: org.id, p_pallets: n, p_notes: null, p_key: key, p_mode: mode, p_hold_reason: mode === 'hold' ? holdWhy.trim() : null,
    p_lines: lines.map((l) => ({ sku: l.sku || null, name: l.sku ? null : l.what.trim(), cartons: lineCartons(l), units_per_carton: l.upc === '' || l.cle ? null : Number(l.upc), fba: l.fba, cle: !!l.cle })) });
  const fail = (text) => setMsg({ text });
  // carton labels before Receive: take the pallet numbers for this form, print with the real barcodes; Receive then uses those numbers
  const printFirst = async (only) => {
    if (problem || !total || locked) return; setBusy(true); setMsg(null);
    try { const data = (await rpc('wms_hold_pskus', { p_key: key, p_pallets: n })).map((r) => (typeof r === 'string' ? r : r.wms_hold_pskus));
      setHold((h) => ({ pskus: data, sig, full: !!(h?.full && h.sig === sig) }));
      if (!(await printCartonLabels(draft(data), () => org.name, only || null, csize, cturn))) fail(`The print window did not open, so nothing was printed for ${data[0]}. The number stays held: print again.`);
      else if (!only) setHold((h) => (h && h.sig === sig ? { ...h, full: true } : h));
    } catch (x) { fail(x.message); } setBusy(false);
  };
  const landed = async (pallets, early) => {
    saveFlight(null); setSent(null); setKey(crypto.randomUUID()); setHold(null); setLines([newLine(s.lines[0]?.sku_id || '')]); setCount(1); if (mode !== 'partial') { setMode('partial'); setHoldWhy(''); } reload();
    try { const got = await labelPallets(pallets.map((p) => p.psku));
      const same = !!early && early.length === got.length && early.every((d, i) => d.psku === got[i].psku && sameLabels(d._cartons, got[i]._cartons));
      setMade(got); setPrinted(same ? { cartons: true, early: true } : early ? { mismatch: true } : {});
      setMsg({ kind: 'ok', text: `${got.length} pallet${got.length === 1 ? '' : 's'} received: ${got.map((p) => p.psku).join(', ')}.` });
    } catch (x) { setMade(null); setMsg({ text: `The pallets are received (${pallets.map((p) => p.psku).join(', ')}), but their labels could not be prepared: ${x.message} Print them from the list on the right.` }); }
  };
  const send = async (f) => { setBusy(true); setMsg(null);
    let res; try { res = await supabase.rpc('wms_receive_booking', f.payload); } catch (x) { res = { data: null, error: { message: String(x?.message || x) }, status: 0 }; }
    const { data, error, status } = res;
    // refused before anything was written: the database raised on the form (400) or the login was not let in (401/403). 408 and 409 are not refusals.
    if (error && status >= 400 && status < 500 && status !== 408 && status !== 409) { saveFlight(null); setSent(null); fail(error.message); }
    else if (error || !data?.length || data.some((p) => p.batch_key && p.batch_key !== f.key)) fail(`No clear answer came back${error ? ` (${error.message})` : ''}. Do not enter it again: press "Check that Receive".`);
    else await landed(data, f.early);
    setBusy(false); };
  const receive = async (e) => { e.preventDefault(); if (problem || locked) return;
    const f = { key, inbound: s.id, payload: payload(), early: hold?.full && !stale ? draft(hold.pskus) : null };
    if (!saveFlight(f)) return fail('Nothing was sent. This station could not save the Receive before sending it (browser storage is blocked or full). Use a normal window or another station.');
    setSent(f); await send(f); };
  const brandOf = () => org.name;
  const printPallet = async (ps) => { if (!(await printPalletLabels(ps, brandOf))) return fail('The print window did not open for the pallet label. Nothing was printed; press Print again.'); setPrinted((x) => ({ ...x, pallet: true })); try { await rpc('nexus_labels_printed', { p_kind: 'pallet', p_codes: ps.map((p) => p.psku) }); reload(); } catch { /* printed; the count catches up on the next print */ } };
  const printCartons = async (ps, only) => { if (!(await printCartonLabels(ps, brandOf, only || null, csize, cturn))) return fail('The print window did not open for the carton labels. Nothing was printed; press Print again.'); if (!only) { setPrinted((x) => ({ ...x, cartons: true })); try { await rpc('nexus_labels_printed', { p_kind: 'carton', p_codes: ps.flatMap((p) => cartonCodes(p).filter((c) => !c.cle).map((c) => c.code)) }); } catch { /* printed */ } } };
  const reprint = async (ps, what) => { try { const got = await labelPallets([ps]); if (what === 'pallet') await printPallet(got); else await printCartons(got); } catch (x) { fail(x.message); } };
  const put = async (e) => { e.preventDefault(); try { const r = await rpc('nexus_putaway', { p_psku: psku, p_location: loc }); setMsg({ kind: 'ok', text: `${r.psku} put away at ${r.location}.` }); setPsku(''); setLoc(''); reload(); } catch (x) { fail(x.message); } };
  const finish = async () => { try { const r = await rpc('nexus_receiving_finish', { p_inbound: s.id }); setMade(null); setMsg({ kind: 'ok', text: r.status === 'received' ? `${s.reference} is fully received: ${r.pallets} pallets. ${org.name}'s WMS now shows it as received.` : `${s.reference} is received with differences (${r.pallets} of ${r.pallets_booked} pallets, ${r.cartons} of ${r.cartons_booked} cartons). ${org.name}'s WMS shows the difference.` }); reload(); } catch (x) { fail(x.message); } };
  const madeCartons = made ? made.reduce((a, p) => a + cartonCodes(p).filter((c) => !c.cle).length, 0) : 0; const z = parseSize(csize);
  const taken = lines.map((l) => l.sku).filter(Boolean);
  return (
    <>
      <div className="head"><div><button className="back" onClick={back}>‹ {org.name}</button><h1>{s.reference}</h1></div>
        <div className="glance"><div><b>{s.pallets}</b><small>Pallets booked</small></div><div><b>{s.pallet_list.length}</b><small>Received</small></div><div><b className={waiting.length ? 'hot' : ''}>{stored}</b><small>Put away</small></div></div></div>
      {sent && !busy && <div className="strip move" data-testid="recv-unsure"><b>A Receive was sent from this station and its answer never came back.</b> Do not enter it again.<button className="btn sm primary" onClick={() => send(sent)}>Check that Receive</button></div>}
      <Msg m={msg} />
      {done && <div className="strip ok" data-testid="recv-done">{s.status === 'received' ? 'Fully received' : 'Received with differences'} · {stamp(s.received_at)}. {org.name}'s WMS has it.</div>}
      {made && <section className="printbox" data-testid="recv-print"><h2>Labels for {made.length === 1 ? made[0].psku : `${made[0].psku} → ${made[made.length - 1].psku}`}</h2>
        {printed.mismatch && <div className="strip bad">The carton labels printed before Receive are not what was received. Take them off and print them again from here.</div>}
        <div className="printrow"><div><b>{made.length} pallet label{made.length > 1 ? 's' : ''} · 4 × 6</b><span className="sm">Paper 4 × 6 in · margins none · scale 100%</span></div><button className={`btn ${printed.pallet ? '' : 'primary'}`} onClick={() => printPallet(made)}>{printed.pallet ? 'Print again' : 'Print'}</button></div>
        {madeCartons > 0 && <div className="printrow"><div><b>{num(madeCartons)} carton label{madeCartons > 1 ? 's' : ''} · {sizeLabel(csize)} in{printed.early ? ' · printed before receiving' : ''}</b><span className="sm">Paper {cturn === 'left' || cturn === 'right' ? `${z.h} × ${z.w}` : `${z.w} × ${z.h}`} in · margins none · scale 100%</span></div>
          <div className="acts" style={{ margin: 0 }}><button className={`btn ${printed.cartons ? '' : 'primary'}`} onClick={() => printCartons(made)}>{printed.cartons ? 'Print again' : `Print ${num(madeCartons)}`}</button><button className="btn sm" onClick={() => printCartons([made[0]], [firstLabelled(made[0])?.seq])}>Test with 1 label</button></div></div>}
        {made[0].mixed && linesOf(made[0]).filter((l) => !l.cle).map((ln) => <div className="printrow" key={ln.from}><div><b>{ln.fba ? 'FBA · ' : ''}{ln.item_name}</b><span className="sm">{ln.cartons} carton{ln.cartons === 1 ? '' : 's'} · labels 1 to {ln.cartons}</span></div><button className="btn sm" onClick={() => printCartons(made, Array.from({ length: ln.cartons }, (_, i) => ln.from + i))}>Print {num(ln.cartons * made.length)}</button></div>)}
        <div className="acts"><button className="btn" onClick={() => setMade(null)}>Labels are on · next pallet</button></div></section>}
      <div className="grid2">
        <div>
          {!done && !s.closed && <section><h2>1 · Receive a pallet</h2>
            <form className="editor" onSubmit={receive} data-testid="recv-form">
              {lines.map((l, i) => { const pr = prodOf(l.sku); return (
                <fieldset className="rline" key={l.id} disabled={locked} data-testid="recv-line">
                  {mixed && <div className="row"><b className="sm">Product {i + 1}</b><button type="button" className="link sm" onClick={() => setLines(lines.filter((x) => x.id !== l.id))}>Remove</button></div>}
                  {l.off ? <label>What is it<input aria-label="Product name" value={l.what} onChange={(e) => setLine(l.id, { what: e.target.value })} placeholder="Product name as printed on the carton" maxLength={140} /><button type="button" className="link sm" onClick={() => setLine(l.id, { off: false, what: '' })}>Back to the list</button></label>
                    : <label>What is on the pallet<select aria-label="Product" value={l.sku} onChange={(e) => (e.target.value === '__off' ? setLine(l.id, { off: true, sku: '' }) : setLine(l.id, { sku: e.target.value }))}>
                      <option value="">Pick the product…</option>
                      <optgroup label="In this shipment">{s.lines.filter((b) => b.sku_id === l.sku || !taken.includes(b.sku_id)).map((b) => <option key={b.sku_id} value={b.sku_id}>{b.sku} · {b.name} ({num(b.qty)} units booked)</option>)}</optgroup>
                      <optgroup label={`Other ${org.name} products`}>{(products || []).filter((p) => !booked.has(p.id) && (p.id === l.sku || !taken.includes(p.id))).slice(0, 400).map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}</optgroup>
                      <option value="__off">Not on the list…</option></select></label>}
                  <div className="three"><label>Cartons<input aria-label="Cartons" type="number" min="1" max="500" value={l.cle ? '' : l.cartons} disabled={l.cle} onChange={(e) => setLine(l.id, { cartons: e.target.value })} /></label>
                    <label>Units per carton<input aria-label="Units per carton" type="number" min="1" value={l.cle ? '' : l.upc} disabled={l.cle} onChange={(e) => setLine(l.id, { upc: e.target.value })} /></label>
                    <div className="toggles"><label className="chk"><input type="checkbox" checked={l.fba} onChange={(e) => setLine(l.id, { fba: e.target.checked })} />FBA</label><label className="chk" title="No carton count: no carton labels, the pallet goes straight to put-away"><input type="checkbox" checked={l.cle} onChange={(e) => setLine(l.id, { cle: e.target.checked })} />NCC</label></div></div>
                  {pr && !mixed && <div className="sm">{pr.sku}{pr.supplier ? ` · ${pr.supplier}` : ''}{pr.asins?.length ? ` · ASIN ${pr.asins.join(' / ')}` : ''}</div>}
                </fieldset>); })}
              <div className="acts"><button type="button" className="btn sm" disabled={locked || lines.length >= 20} onClick={() => setLines([...lines, newLine()])}>+ Another product on this pallet</button></div>
              <div className="two"><label>Pallets like this<input aria-label="Pallets like this" type="number" min="1" max="60" value={count} disabled={locked} onChange={(e) => setCount(e.target.value)} /></label>
                <label>After this<select aria-label="After this" value={mode} disabled={locked} onChange={(e) => setMode(e.target.value)}><option value="partial">More of this shipment is still coming</option><option value="final">This is the last of this shipment</option><option value="hold">Put on HOLD (something is wrong)</option></select></label></div>
              {mode === 'hold' && <label>Why is it on HOLD?<input aria-label="Hold reason" value={holdWhy} onChange={(e) => setHoldWhy(e.target.value)} /></label>}
              <div className="acts"><button className="btn primary big" disabled={!!problem || locked}>{busy ? 'Working…' : problem || `Receive ${n} ${mixed ? 'mixed ' : ''}pallet${n > 1 ? 's' : ''}${total ? ` · ${num(total * n)} carton${total * n > 1 ? 's' : ''}` : ''}`}</button></div>
            </form></section>}
          {!done && <section><h2>2 · Put away</h2>
            <form className="acts" onSubmit={put} data-testid="recv-put"><input aria-label="Pallet" placeholder="Scan pallet label" value={psku} onChange={(e) => setPsku(e.target.value)} /><input aria-label="Position" placeholder="Scan position code" value={loc} onChange={(e) => setLoc(e.target.value)} /><button className="btn primary" disabled={!psku.trim() || !loc.trim()}>Put away</button></form>
            <p className="sm">{waiting.length ? `${waiting.length} pallet${waiting.length === 1 ? '' : 's'} of this shipment still to put away.` : s.pallet_list.length ? 'Every pallet received so far is in a position.' : 'Nothing received yet.'} Scan the pallet's label, then the position's code from the pallet-jack sheet.</p></section>}
          {!done && <section><h2>3 · Complete</h2><p className="sm">When the last pallet is received and all of them are in a position, complete the shipment. That tells {org.name}'s WMS it went through the whole receiving process.</p>
            <div className="acts"><button className="btn primary" onClick={finish} disabled={!s.closed || waiting.length > 0}>Complete receiving</button>{!s.closed && <span className="sm">Waiting for the last pallet</span>}{s.closed && waiting.length > 0 && <span className="sm">Waiting for put-away</span>}</div></section>}
        </div>
        <div>
          {!done && !s.closed && <section data-testid="recv-labels"><div className="row"><h2>Labels</h2><span className="sm">4 × 6 and {sizeLabel(csize)} in</span></div>
            <div className="previews"><LabelView html={labelHtml(sample, org.name)} w={4} h={6} inch={44} />
              <div>{linesOf(sample).filter((ln) => !ln.cle).slice(0, 3).map((ln) => <LabelView key={ln.from} html={cartonLabelHtml(sample, org.name, cartonCodes(sample)[ln.from - 1], z.key)} w={z.w} h={z.h} inch={Math.min(190 / z.w, 110 / z.h)} />)}
                {lines.every((l) => l.cle) && <p className="sm">NCC: no carton count and no carton labels. The pallet goes straight to put-away.</p>}</div></div>
            <div className="acts"><select aria-label="Carton label size" value={csize} onChange={(e) => { setCartonSize(e.target.value); setCs(parseSize(e.target.value).key); }}>{CARTON_SIZES.map(([k, l]) => <option key={k} value={k}>{l} in</option>)}</select>
              <select aria-label="Carton label direction" value={cturn} onChange={(e) => { setCartonTurn(e.target.value); setCt(e.target.value); }}>{CARTON_TURNS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            {total > 0 && !problem && <>
              {stale && <div className="strip bad">The form changed after labels were printed for {hold.pskus[0]}. Print them again, or put the form back.</div>}
              {hold && !stale && <div className="strip ok">{hold.full ? `Carton labels printed for ${hold.pskus.join(', ')}. Press Receive when they are on.` : `${hold.pskus[0]} is held for this pallet. Not every carton label is printed yet.`}</div>}
              <div className="acts"><button type="button" className="btn" disabled={locked} onClick={() => printFirst()}>{hold?.full && !stale ? 'Print again' : 'Print carton labels now'} · {num(total * n)}</button><button type="button" className="btn sm" disabled={locked} onClick={() => printFirst([firstLabelled(sample)?.seq])}>Test with 1 label</button>
                {hold && <button type="button" className="link sm" disabled={locked} onClick={() => { setHold(null); setKey(crypto.randomUUID()); }}>Throw those labels away and start over</button>}</div></>}
          </section>}
          <section><h2>Booked by {org.name}'s WMS</h2><div className="facts wide"><span>Expected<b>{s.expected_at ? day(`${s.expected_at}T12:00`) : '—'}</b></span><span>Pallets<b>{s.pallets}</b></span><span>Cartons<b>{s.cartons || '—'}</b></span></div>
            {s.lines.map((l) => <div className="hist" key={l.sku_id}><b>{num(l.qty)} units</b> {l.sku}<span>{l.name}</span></div>)}{s.origin && <p className="sm">From {s.origin}</p>}{s.notes && <p className="sm">{s.notes}</p>}</section>
          <section><h2>Pallets received · {s.pallet_list.length}</h2>{s.pallet_list.map((p) => <div className="pal" key={p.psku} data-testid="recv-pallet"><div className="row"><button className="link code" onClick={() => setPsku(p.psku)}>{p.psku}</button><Pill p={p} /></div>
            <div className="sm">{p.item} · {p.cartons ?? 'no count'} cartons · {p.position ? (p.status === 'stored' ? `at ${p.position}` : `suggested ${p.position}`) : 'no position yet'} · label printed {p.label_prints}×{p.held ? ` · HOLD: ${p.hold_reason}` : ''}</div>
            <div className="acts"><button className="btn sm" onClick={() => reprint(p.psku, 'pallet')}>Pallet label</button>{p.cartons > 0 && <button className="btn sm" onClick={() => reprint(p.psku, 'cartons')}>Carton labels</button>}</div></div>)}{s.pallet_list.length === 0 && <p className="sm">None yet.</p>}</section>
        </div>
      </div>
    </>);
}
