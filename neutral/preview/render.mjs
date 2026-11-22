// Draws the prelaunch map from what the service answers (GET /v1/map and /v1/occupancy on the live floor of a local database
// loaded with nothing but the migrations) and saves a picture: node neutral/preview/render.mjs <out.png>
import pg from 'pg'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { chromium } from 'playwright'; import { serve } from '../service/server.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)); const base = 'postgres://postgres@127.0.0.1:54318'; const out = process.argv[2] || '/tmp/nexus-prelaunch-map.png';
const admin = new pg.Client(`${base}/postgres`); await admin.connect(); await admin.query('drop database if exists nexuspreview'); await admin.query('create database nexuspreview'); await admin.end();
const svc = await serve(`${base}/nexuspreview`);
for (const f of ['001_core.sql', '002_floor_map.sql', '003_calendar.sql']) await svc.pool.query(fs.readFileSync(path.join(here, '..', f), 'utf8'));
const co = (await svc.pool.query(`insert into nexus.companies (code, name) values ('PREVIEW', 'Preview') returning id`)).rows[0].id;
const key = (await svc.pool.query(`select nexus.integration_create('preview', $1, 'preview', 'HILLSBOROUGH', '{read}') k`, [co])).rows[0].k;
const get = async (p) => (await fetch(svc.url + p, { headers: { authorization: `Bearer ${key}` } })).json();
const map = await get('/v1/map'), occ = await get('/v1/occupancy'); await svc.close();
const used = Object.fromEntries(occ.locations.map((l) => [l.code, l.used])); const g = map.layout.grid;
const drawn = map.positions.filter((p) => p.x != null); const n = (b) => drawn.filter((p) => p.block === b).length; const total = occ.locations.reduce((t, l) => t + l.used, 0);
const span = (a) => `${a[0]} / ${a[1] + 1}`; const lm = (k) => map.landmarks.find((l) => l.key === k); const blk = (k) => map.layout.blocks.find((x) => x.key === k);
// grid rows: 1 = top doors, 2 = block names, 3 … rows+2 = the floor, rows+3 = bottom landmarks
const cells = drawn.map((p) => `<div class="c${p.kind === 'staging' ? ' stg' : ''}${used[p.code] ? ' full' : ''}" style="grid-column:${p.x};grid-row:${p.y + 2}">${p.kind === 'pallet' ? p.code.replace('P-', '') : p.code}</div>`).join('');
const doors = map.landmarks.filter((l) => l.edge).map((l) => `<div class="door" style="grid-column:${span(l.x)};grid-row:${l.edge === 'top' ? 1 : g.rows + 3}">${l.label.toUpperCase()}</div>`).join('');
const names = ['outbound', 'inbound'].map((k) => `<small style="grid-column:${span(blk(k).x)};grid-row:2">${blk(k).label.toUpperCase()} · ${n(k)}</small>`).join('') + `<small style="grid-column:${span(blk('staging').x)};grid-row:${blk('staging').y[0] + 1};align-self:end">STAGING</small>`;
const walk = `<div class="walk" style="grid-column:${span(lm('walkway').x)};grid-row:3 / ${g.rows + 3}"><span>WALKWAY</span></div>`;
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#0d1014;color:#e8eaed;font:700 13px Arial,sans-serif;padding:28px;width:760px}
h1{font:800 22px Arial;letter-spacing:.14em;margin:0 0 4px}.sub{color:#9aa3ad;margin-bottom:14px}
.flag{border:1px solid #f0a020;color:#f0a020;padding:8px 12px;margin-bottom:18px;letter-spacing:.06em}
.plan{display:grid;grid-template-columns:repeat(2,84px) 150px repeat(2,84px);grid-auto-rows:30px;gap:5px 10px;justify-content:center;border:1px solid #2a313a;padding:20px}
.door{border:1px solid #5b6672;display:flex;align-items:center;justify-content:center;letter-spacing:.1em;white-space:nowrap;justify-self:center;padding:0 14px}
small{color:#9aa3ad;letter-spacing:.1em;text-align:center;align-self:center}
.c{border:1px solid #3a444f;display:flex;align-items:center;justify-content:center;color:#cfd5db}.c.stg{border-style:dashed}.c.full{background:#f0a020;color:#000}
.walk{display:flex;align-items:center;justify-content:center;border-left:1px dashed #2a313a;border-right:1px dashed #2a313a;margin:0 22px}.walk span{writing-mode:vertical-rl;color:#5b6672;letter-spacing:.3em}
.note{margin-top:12px;color:#9aa3ad;font-weight:400}</style>
<h1>NEXUS · PRELAUNCH MAP</h1><div class="sub">${map.warehouse} · map version ${map.map_version} · ${n('outbound') + n('inbound')} pallet positions + ${n('staging')} staging · ${total} occupied</div>
<div class="flag">OCCUPANCY ${map.occupancy_state.replace('_', ' ').toUpperCase()} · UNVERIFIED · ASSIGN / MOVE / RELEASE OFF</div>
<div class="plan">${doors}${names}${walk}${cells}</div>
<div class="note">Empty squares mean nothing has been entered yet, not that the warehouse is empty. Checksum ${map.checksum.slice(0, 16)}…</div>`;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' }); const pg1 = await b.newPage({ viewport: { width: 816, height: 900 }, deviceScaleFactor: 2 });
await pg1.setContent(html); await pg1.screenshot({ path: out, fullPage: true }); await b.close(); console.log(out, n('outbound'), n('inbound'), n('staging'), total, map.map_version, map.checksum);
