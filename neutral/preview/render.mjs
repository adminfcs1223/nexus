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
const used = Object.fromEntries(occ.locations.map((l) => [l.code, l.used]));
const line = (block, col) => map.positions.filter((p) => p.block === block && p.col === col).sort((a, b) => a.row - b.row);
const cell = (p) => `<div class="c${used[p.code] ? ' full' : ''}">${p.code.replace('P-', '')}</div>`;
const blockHtml = (b) => `<div class="block">${[1, 2].map((c) => `<div class="line">${line(b, c).map(cell).join('')}</div>`).join('')}</div>`;
const n = (b) => map.positions.filter((p) => p.block === b).length; const total = occ.locations.reduce((t, l) => t + l.used, 0);
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#0d1014;color:#e8eaed;font:700 13px Arial,sans-serif;padding:28px;width:760px}
h1{font:800 22px Arial;letter-spacing:.14em;margin:0 0 4px}.sub{color:#9aa3ad;margin-bottom:14px}
.flag{border:1px solid #f0a020;color:#f0a020;padding:8px 12px;margin-bottom:18px;letter-spacing:.06em}
.plan{display:grid;grid-template-columns:1fr 90px 1fr;gap:0;border:1px solid #2a313a;padding:18px}
.side{display:flex;flex-direction:column;align-items:center;gap:8px}.door{border:1px solid #5b6672;padding:4px 18px;letter-spacing:.12em}
small{color:#9aa3ad;letter-spacing:.1em}.block{display:flex;gap:8px}.line{display:flex;flex-direction:column;gap:4px}
.c{width:64px;height:26px;border:1px solid #3a444f;display:flex;align-items:center;justify-content:center;color:#cfd5db}.c.full{background:#f0a020;color:#000}
.walk{display:flex;align-items:center;justify-content:center;border-left:1px dashed #2a313a;border-right:1px dashed #2a313a;margin:0 14px}.walk span{writing-mode:vertical-rl;color:#5b6672;letter-spacing:.3em}
.stage{margin-top:14px;display:flex;flex-direction:column;align-items:center;gap:6px}.stage .row{display:flex;gap:8px}.stage .c{width:64px;height:40px;border-style:dashed}
.foot{grid-column:1/-1;display:flex;justify-content:space-between;align-items:center;margin-top:18px;border-top:1px solid #2a313a;padding-top:12px;color:#9aa3ad}
.note{margin-top:12px;color:#9aa3ad;font-weight:400}</style>
<h1>NEXUS · PRELAUNCH MAP</h1><div class="sub">${map.warehouse} · map version ${map.map_version} · ${n('outbound') + n('inbound')} pallet positions + ${n('staging')} staging · ${total} occupied</div>
<div class="flag">OCCUPANCY ${map.occupancy_state.replace('_', ' ').toUpperCase()} · UNVERIFIED · ASSIGN / MOVE / RELEASE OFF</div>
<div class="plan"><div class="side"><div class="door">EXIT</div><small>OUTBOUND · ${n('outbound')}</small>${blockHtml('outbound')}</div>
<div class="walk"><span>WALKWAY</span></div>
<div class="side"><div class="door">DOCK</div><small>INBOUND · ${n('inbound')}</small>${blockHtml('inbound')}
<div class="stage"><small>STAGING</small><div class="row">${[1, 2].map((c) => line('staging', c).map((p) => `<div class="c">${p.code}</div>`).join('')).join('')}</div></div></div>
<div class="foot"><span>PREP AREA</span><div class="door">ENTRANCE</div></div></div>
<div class="note">Empty squares here mean nothing has been entered yet, not that the warehouse is empty. Codes kept but not drawn: ${map.not_drawn.map((x) => x.code).join(', ')}.</div>`;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' }); const pg1 = await b.newPage({ viewport: { width: 816, height: 900 }, deviceScaleFactor: 2 });
await pg1.setContent(html); await pg1.screenshot({ path: out, fullPage: true }); await b.close(); console.log(out, n('outbound'), n('inbound'), n('staging'), total);
