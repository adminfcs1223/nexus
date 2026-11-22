// Floor map, drawn from the warehouse sketch: Exit and Dock at the top, entrance at the bottom. Outbound side (two lines) on the
// left, walkway, inbound side under the dock (the original line plus the line along the wall), two staging spots by the prep area.
// Which position code sits in which square is an assumption until confirmed on the floor: change LAYOUT only.
// This file only draws. Whoever shows it supplies the positions (staff screens: nexus_map; a key window: nexus_api_floor).
const ROWS = 18; const P = (n) => `P-${String(n).padStart(2, '0')}`;
const col = (from) => Array.from({ length: ROWS }, (_, i) => P(from + i));
export const LAYOUT = { outbound: [col(37), col(55)], inbound: [col(1), col(19)], staging: ['STG-01', 'STG-02'] };
const DRAWN = new Set([...LAYOUT.outbound.flat(), ...LAYOUT.inbound.flat(), ...LAYOUT.staging]);
const HUES = [355, 205, 145, 40, 275, 175, 20, 310];
export const brandsOf = (m) => [...new Set((m?.positions || []).flatMap((p) => p.pallets.map((x) => x.brand)).concat((m?.unplaced || []).map((x) => x.brand)))].sort();
export const hueOf = (brands, b) => HUES[Math.max(0, brands.indexOf(b)) % HUES.length];
export const capacity = (m) => { const pal = (m?.positions || []).filter((p) => p.kind === 'pallet'); const used = pal.filter((p) => p.pallets.length || p.taken).length; return { used, total: pal.length, free: pal.length - used }; };

// size: 'mini' (dashboard), 'full'. target: true while a pallet is being moved (free squares light up, taken ones are locked).
export default function FloorMap({ m, sel, onSel, size = 'full', target = false }) {
  const by = Object.fromEntries(m.positions.map((p) => [p.code, p])); const brands = brandsOf(m);
  const extra = m.positions.filter((p) => !DRAWN.has(p.code)).map((p) => p.code);   // positions added later that the sketch does not place yet
  const Cell = ({ code }) => {
    const p = by[code]; const top = p?.pallets[0]; const taken = !!(top || p?.taken); const free = p && !taken;
    const cls = `cell${!p ? ' none' : ''}${top ? ' full' : taken ? ' taken' : ''}${top?.held ? ' held' : ''}${sel === code ? ' on' : ''}${target && free ? ' drop' : ''}`;
    return (
      <button className={cls} data-testid={`cell-${code}`} disabled={!p || !onSel || (target && !free && p.kind === 'pallet')} style={top ? { '--h': hueOf(brands, top.brand) } : undefined} onClick={() => onSel(code)}
        title={!p ? `${code}: not set up` : top ? `${code} · ${top.brand} · ${top.psku}` : taken ? `${code}: in use` : `${code}: free`}>
        <b>{code.replace('P-', '')}</b>{p?.pallets.length > 1 && <i>{p.pallets.length}</i>}
      </button>);
  };
  const Block = ({ cols }) => <div className="block">{cols.map((c, i) => <div className="line" key={i}>{c.map((code) => <Cell key={code} code={code} />)}</div>)}</div>;
  return (
    <div className={`plan ${size}`} data-testid="floor-map">
      <div className="side"><div className="door">Exit</div><small>Outbound</small><Block cols={LAYOUT.outbound} /></div>
      <div className="walk"><span>Walkway</span></div>
      <div className="side"><div className="door">Dock</div><small>Inbound</small><Block cols={LAYOUT.inbound} />
        <div className="stage"><small>Staging</small><div className="line row">{LAYOUT.staging.map((c) => <Cell key={c} code={c} />)}</div></div></div>
      {extra.length > 0 && <div className="extra"><small>Added positions, not on the sketch yet</small><div className="line row wrap">{extra.map((c) => <Cell key={c} code={c} />)}</div></div>}
      <div className="foot"><span>Prep area</span><div className="door">Entrance</div></div>
    </div>);
}
export function Legend({ m, own }) {
  const brands = brandsOf(m);
  return <div className="legend">{brands.map((b) => <span key={b}><i style={{ '--h': hueOf(brands, b) }} />{b}</span>)}{own && <span><i className="t" />In use</span>}<span><i className="e" />Free</span><span><i className="x" />Not set up</span></div>;
}
