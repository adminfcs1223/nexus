// Position labels and the pallet-jack scan sheet, printed from Nexus (the warehouse's shared controls live here, not in any one WMS).
import JsBarcode from 'jsbarcode';
import { printLocationLabels } from './labels/label.js';
import { printPages } from './labels/print.js';
import { esc } from './lib.js';
/** 4x6 position labels, one per page: the code large, its zone, and the LOC-<code> barcode the put-away scan reads. */
export const printPositionLabels = (rows) => printLocationLabels(rows, '4x6');
const bars = (v) => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); JsBarcode(svg, v, { format: 'CODE128', displayValue: false, margin: 0, height: 60, width: 2 }); svg.setAttribute('preserveAspectRatio', 'none'); svg.removeAttribute('width'); svg.removeAttribute('height'); svg.removeAttribute('style'); svg.setAttribute('viewBox', `0 0 ${svg.querySelector('rect')?.getAttribute('width') || 200} 60`); return svg.outerHTML; };
const SHEET_CSS = `.jack { width: 8.5in; height: 11in; padding: .4in .45in; box-sizing: border-box; font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff; display: flex; flex-direction: column; }
  .jack header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 3px solid #000; padding-bottom: .08in; margin-bottom: .12in; } .jack header b { font-size: .26in; } .jack header span { font-size: .13in; font-weight: 700; }
  .jack .grid { flex: 1; display: grid; grid-template-columns: repeat(3, 1fr); grid-auto-rows: 1fr; gap: .1in .18in; }
  .jack .p { border: 1.5px solid #000; padding: .06in .1in .05in; display: flex; flex-direction: column; min-height: 0; } .jack .p b { font-size: .3in; line-height: 1; } .jack .p small { font-size: .09in; font-weight: 700; text-transform: uppercase; }
  .jack .p div { flex: 1; min-height: 0; padding: .04in .1in 0; } .jack .p svg { width: 100%; height: 100%; display: block; }`;
/** Letter pages for the pallet jacks: every position's code and barcode, 24 to a page, in code order. With no racking,
 *  the number is posted at the spot and this sheet rides on the jack: scan the pallet label, then the spot's code here. */
export function printJackSheet(rows, per = 24) {
  const list = [...rows].sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true })); const pages = [];
  for (let i = 0; i < list.length; i += per) pages.push(`<section class="jack"><header><b>NEXUS · position scan sheet</b><span>${esc(list[i].code)} to ${esc(list[Math.min(i + per, list.length) - 1].code)} · page ${i / per + 1} of ${Math.ceil(list.length / per)}</span></header><div class="grid">${list.slice(i, i + per).map((l) => `<div class="p"><b>${esc(l.code)}</b><small>${esc(l.zone || '')}</small><div>${bars(`LOC-${l.code}`)}</div></div>`).join('')}</div></section>`);
  return printPages(pages, 'jack', '8.5in 11in', 'Pallet-jack scan sheet', true, SHEET_CSS);
}
// "P-65..P-72" or "P-65, P-66" -> list of codes
export function expandCodes(text) {
  const out = [];
  for (const part of String(text || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^(.*?)(\d+)\s*\.\.\s*(?:\1)?(\d+)$/);
    if (!m) { out.push(part.toUpperCase()); continue; }
    const [, pre, a, b] = m; const lo = Number(a), hi = Number(b); if (hi < lo || hi - lo > 200) throw new Error('Check the range.');
    for (let n = lo; n <= hi; n++) out.push(`${pre}${String(n).padStart(a.length, '0')}`.toUpperCase());
  }
  return out;
}
