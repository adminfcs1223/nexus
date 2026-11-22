// Sites: the WMSes that use this warehouse (ShipBay, Souled, …). A site holds its brands (shown everywhere as "c/o"), how it
// connects, and for a site on its own system its two keys and what each may do. "Add a site" walks through it and ends on a
// connection check, so a site is never left half set up.
import { useEffect, useState } from 'react';
import { supabase, rpc, num, stamp } from './lib.js';
import { Msg } from './parts.jsx';

const PERMS = { floor: [['map', 'See the floor map'], ['brands', 'See its own pallets on the map'], ['scan', 'Scan pallets into positions']], admin: [['map', 'See the floor map'], ['brands', 'See its own pallets on the map'], ['scan', 'Scan pallets into positions'], ['calendar', 'Book and change incoming shipments'], ['labels', 'See its labels']] };
const DEFAULT = { floor: { map: true, brands: true, scan: true }, admin: { map: true, brands: true, scan: true, calendar: true, labels: true } };
const KIND = { shared: 'Same database as Nexus', api: 'Its own system' };
const windowUrl = (access, key) => `${window.location.origin}/?window=${access}#k=${key}`;
/** How fresh a site's data is, in words. A shared site cannot be stale; a site on its own system is as fresh as its last call. */
export const freshness = (s) => (!s.active ? { text: 'Turned off', cls: 'closed' } : s.kind === 'shared' ? { text: 'Live', cls: 'stored' } : !s.heard_at ? { text: 'Never connected', cls: 'held' }
  : Date.now() - new Date(s.heard_at) < 15 * 60000 ? { text: 'Connected', cls: 'stored' } : { text: `Last heard ${stamp(s.heard_at)}`, cls: 'counted' });

function PermBoxes({ perms, set }) {
  return <div className="perms">{['floor', 'admin'].map((w) => <div key={w}><h2 className="sub">{w === 'floor' ? 'Floor key' : 'Admin key'}</h2>{PERMS[w].map(([k, l]) => <label key={k} className="chk"><input type="checkbox" checked={!!perms[w][k]} onChange={() => set({ ...perms, [w]: { ...perms[w], [k]: !perms[w][k] } })} />{l}</label>)}</div>)}</div>;
}
function KeyBox({ label, access, value }) {
  return <div className="strip ok keybox" data-testid={`key-${access}`}><b>{label}. Copy it now: it is shown once and not stored.</b><code>{value}</code><small>Address to load inside the site's own system</small><code>{windowUrl(access, value)}</code></div>;
}
// brands a site can take: its own, and any that no other site holds
function BrandPicker({ all, sites, siteId, ids, set }) {
  const owner = (id) => sites.find((s) => s.id !== siteId && s.org_ids.includes(id));
  return <div className="checks">{all.map((b) => { const o = owner(b.id); return <label key={b.id} className="chk" style={o ? { opacity: 0.45 } : undefined} title={o ? `Already under ${o.name}` : ''}><input type="checkbox" disabled={!!o} checked={ids.includes(b.id)} onChange={() => set(ids.includes(b.id) ? ids.filter((x) => x !== b.id) : [...ids, b.id])} />{b.name}{o ? ` (${o.name})` : ''}</label>; })}</div>;
}

export default function Sites({ data, reload }) {
  const [all, setAll] = useState([]); const [msg, setMsg] = useState(null); const [edit, setEdit] = useState(null); const [made, setMade] = useState(null); const [wiz, setWiz] = useState(null);
  useEffect(() => { rpc('nexus_brands').then(setAll).catch(() => {}); }, []);
  if (!data) return <div className="empty">Loading…</div>;
  const sites = data.sites;
  const save = async () => { try { await rpc('nexus_site_save', { p_id: edit.id, p_name: edit.name, p_kind: edit.kind, p_org_ids: edit.org_ids, p_perms: edit.perms }); setMsg({ kind: 'ok', text: `${edit.name} saved.` }); setEdit(null); reload(); } catch (x) { setMsg({ text: x.message }); } };
  const newKey = async (s, access) => { try { const k = await rpc('nexus_connection_new_key', { p_id: s.id, p_access: access }); setMade({ name: s.name, [access]: k }); reload(); } catch (x) { setMsg({ text: x.message }); } };
  const toggle = async (s) => { await supabase.rpc('nexus_client_set_active', { p_id: s.id, p_active: !s.active }); reload(); };
  if (wiz) return <Wizard wiz={wiz} setWiz={setWiz} all={all} data={data} reload={reload} />;
  return (
    <>
      <div className="head"><h1>Sites</h1><div className="glance"><div><b>{sites.filter((s) => s.active).length}</b><small>Sites</small></div><div><b>{sites.filter((s) => s.active && ['Live', 'Connected'].includes(freshness(s).text)).length}</b><small>Up to date</small></div><div><b className={data.unassigned.length ? 'hot' : ''}>{data.unassigned.length}</b><small>Brands with no site</small></div></div></div>
      <Msg m={msg} />
      {data.unassigned.length > 0 && <div className="strip bad" data-testid="unassigned">No site yet: {data.unassigned.map((b) => b.name).join(', ')}. Their shipments show under "No site yet" until a site takes them.</div>}
      {made && <div data-testid="new-keys"><h2>Keys for {made.name}</h2>{made.floor && <KeyBox label="Floor key" access="floor" value={made.floor} />}{made.admin && <KeyBox label="Admin key" access="admin" value={made.admin} />}</div>}
      <div className="acts" style={{ margin: '0 0 16px' }}><button className="btn primary" onClick={() => { setMsg(null); setMade(null); setWiz({ step: 1, name: '', kind: 'shared', org_ids: [], perms: DEFAULT }); }}>Add a site</button></div>
      {sites.map((s) => { const e = edit?.id === s.id ? edit : null; const f = freshness(s); return (
        <section key={s.id} className="conn" data-testid="site">
          <div className="row"><h3>{s.name}</h3><div className="acts" style={{ margin: 0 }}><span className={`pill ${f.cls}`}>{f.text}</span><button className="btn sm" onClick={() => toggle(s)}>{s.active ? 'Turn off' : 'Turn on'}</button>{!e && <button className="btn sm primary" onClick={() => setEdit({ id: s.id, name: s.name, kind: s.kind, org_ids: s.org_ids, perms: s.perms })}>Change</button>}</div></div>
          {!e ? <>
            <div className="facts"><span>Connects as<b>{KIND[s.kind]}</b></span><span>Brands (c/o)<b>{s.brands.map((b) => b.name).join(', ') || 'None yet'}</b></span><span>Shipments to receive<b>{num(s.open_shipments)}</b></span><span>Pallets on file<b>{num(s.pallets)}</b></span></div>
            <p className="sm">{s.kind === 'shared' ? `Its bookings and products are read straight from the database, so they are never out of date. Last change ${stamp(s.last_change)}.` : s.heard_at ? `Floor key last used ${stamp(s.floor_used_at)} · admin key last used ${stamp(s.admin_used_at)}.` : 'This site has not connected yet. Give it its keys, then it shows as connected on its first call.'}</p>
            {s.kind === 'api' && <div className="perms read">{['floor', 'admin'].map((w) => <div key={w}><h2 className="sub">{w === 'floor' ? 'Floor key can' : 'Admin key can'}</h2>{PERMS[w].map(([k, l]) => <div key={k} className={s.perms[w][k] ? 'yes' : 'no'}>{s.perms[w][k] ? '✓' : '✕'} {l}</div>)}
              <button className="btn sm" onClick={() => newKey(s, w)}>{w === 'admin' && !s.has_admin_key ? 'Make the admin key' : `New ${w} key (the old one stops working)`}</button></div>)}</div>}</>
            : <div className="editor"><label>Name<input aria-label="Site name" value={e.name} onChange={(x) => setEdit({ ...e, name: x.target.value })} /></label>
              <label>Connects as<select aria-label="Connects as" value={e.kind} onChange={(x) => setEdit({ ...e, kind: x.target.value })}><option value="shared">{KIND.shared}</option><option value="api">{KIND.api}</option></select></label>
              <h2 className="sub">Brands (c/o)</h2><BrandPicker all={all} sites={sites} siteId={s.id} ids={e.org_ids} set={(ids) => setEdit({ ...e, org_ids: ids })} />{e.kind === 'api' && <PermBoxes perms={e.perms} set={(p) => setEdit({ ...e, perms: p })} />}
              <div className="acts"><button className="btn primary" onClick={save}>Save</button><button className="btn" onClick={() => setEdit(null)}>Cancel</button></div></div>}
        </section>); })}
      {sites.length === 0 && <div className="empty">No site is set up yet.</div>}
      <section className="api"><h2>Who owns what</h2><p>A site owns its brands, products, bookings and orders. Nexus owns positions, pallets, labels and receipts. Neither edits the other's; each sees the other's as it changes. A site on the same database is always live. A site on its own system books shipments and reads results with its admin key, and shows here when it was last heard from.</p></section>
    </>);
}

const STEPS = ['Name', 'How it connects', 'Brands', 'Permissions', 'Check'];
function Wizard({ wiz, setWiz, all, data, reload }) {
  const [err, setErr] = useState(null); const [busy, setBusy] = useState(false); const set = (p) => setWiz({ ...wiz, ...p });
  const site = wiz.made && data.sites.find((s) => s.id === wiz.made.id); const f = site && freshness(site);
  useEffect(() => { if (wiz.step !== 5) return undefined; const t = setInterval(reload, 4000); return () => clearInterval(t); }, [wiz.step]);
  const next = () => { setErr(null);
    if (wiz.step === 1 && !wiz.name.trim()) return setErr('Name the site.');
    if (wiz.step === 1 && data.sites.some((s) => s.name.toLowerCase() === wiz.name.trim().toLowerCase())) return setErr(`There is already a site called ${wiz.name.trim()}.`);
    set({ step: wiz.step === 3 && wiz.kind === 'shared' ? 5 : wiz.step + 1, ...(wiz.step === 3 && wiz.kind === 'shared' ? { create: true } : {}) }); };
  const create = async () => { setBusy(true); setErr(null); try { const d = await rpc('nexus_site_save', { p_id: null, p_name: wiz.name, p_kind: wiz.kind, p_org_ids: wiz.org_ids, p_perms: wiz.perms }); set({ step: 5, made: d, create: false }); reload(); } catch (x) { setErr(x.message); set({ step: 3, create: false }); } setBusy(false); };
  useEffect(() => { if (wiz.create && !wiz.made && !busy) create(); }, [wiz.create]);
  const shown = wiz.kind === 'shared' ? STEPS.filter((s) => s !== 'Permissions') : STEPS; const at = STEPS[wiz.step - 1];
  return (
    <>
      <div className="head"><div><button className="back" onClick={() => setWiz(null)}>‹ Sites</button><h1>Add a site</h1></div></div>
      <ol className="steps" data-testid="wizard-steps">{shown.map((s, i) => <li key={s} className={s === at ? 'on' : shown.indexOf(at) > i ? 'done' : ''}><b>{i + 1}</b>{s}</li>)}</ol>
      <Msg m={err && { text: err }} />
      <section className="editor wizard" data-testid="wizard">
        {wiz.step === 1 && <label>What is the site called?<input aria-label="Site name" autoFocus placeholder="e.g. Souled" value={wiz.name} onChange={(e) => set({ name: e.target.value })} /></label>}
        {wiz.step === 2 && <div className="choice">{[['shared', 'Its WMS runs on the same database as Nexus', 'Its bookings and products are live here the moment they change. Nothing to connect, no keys.'], ['api', 'It runs on its own system', 'It gets two keys. It books shipments and reads results with them, and Nexus shows when it was last heard from.']].map(([k, t, d]) => (
          <button type="button" key={k} className={wiz.kind === k ? 'on' : ''} onClick={() => set({ kind: k })} data-testid={`kind-${k}`}><b>{t}</b><span>{d}</span></button>))}</div>}
        {wiz.step === 3 && <><h2 className="sub">Which brands does {wiz.name.trim()} handle? They show as "c/o" under it.</h2><BrandPicker all={all} sites={data.sites} siteId={null} ids={wiz.org_ids} set={(ids) => set({ org_ids: ids })} /><p className="sm">A brand under another site is greyed out: move it off that site first. A site can start with no brands.</p></>}
        {wiz.step === 4 && <><h2 className="sub">What may each of {wiz.name.trim()}'s keys do?</h2><PermBoxes perms={wiz.perms} set={(p) => set({ perms: p })} /></>}
        {wiz.step === 5 && !wiz.made && <p className="sm">Setting up {wiz.name.trim()}…</p>}
        {wiz.step === 5 && wiz.made && <div data-testid="wizard-check">
          {wiz.kind === 'api' && <><KeyBox label="Floor key" access="floor" value={wiz.made.floor_key} /><KeyBox label="Admin key" access="admin" value={wiz.made.admin_key} /></>}
          <h2 className="sub">Connection check</h2>
          {!site ? <p className="sm">Reading…</p> : wiz.kind === 'shared'
            ? <div className="strip ok"><b>{site.name} is live.</b> Nexus reads {site.brands.length} brand{site.brands.length === 1 ? '' : 's'}, {num(site.open_shipments)} shipment{site.open_shipments === 1 ? '' : 's'} to receive and {num(site.pallets)} pallet{site.pallets === 1 ? '' : 's'} straight from the database.</div>
            : site.heard_at ? <div className="strip ok"><b>{site.name} is connected.</b> Its first call arrived {stamp(site.heard_at)}.</div>
              : <div className="strip move"><b>Waiting for {site.name}'s first call.</b> Open one of the two addresses above inside its system. This turns green by itself.</div>}
          {f && <p className="sm">Status: {f.text}</p>}
        </div>}
        <div className="acts">
          {wiz.step > 1 && wiz.step < 5 && <button type="button" className="btn" onClick={() => set({ step: wiz.step - 1 })}>Back</button>}
          {wiz.step < 3 && <button type="button" className="btn primary" onClick={next}>Next</button>}
          {wiz.step === 3 && <button type="button" className="btn primary" disabled={busy} onClick={next}>{wiz.kind === 'shared' ? 'Create the site' : 'Next'}</button>}
          {wiz.step === 4 && <button type="button" className="btn primary" disabled={busy} onClick={() => set({ create: true })}>Create the site and its keys</button>}
          {wiz.step === 5 && wiz.made && <button type="button" className="btn primary" onClick={() => setWiz(null)}>Done</button>}
        </div>
      </section>
    </>);
}
