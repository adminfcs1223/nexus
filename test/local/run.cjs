// Nexus v2 in a real browser against the local synthetic database. Every request off 127.0.0.1 is blocked and counted.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const http = require('http');
const OUT = '/tmp/nexus-local'; const DIR = `${OUT}/build`; fs.mkdirSync(`${OUT}/shots`, { recursive: true });
let pass = 0, fail = 0; const ok = (c, w) => { c ? pass++ : fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${w}`); };
const server = http.createServer((req, res) => { const p = decodeURIComponent(String(req.url).split('?')[0]); const f = path.resolve(DIR, '.' + p); const file = f.startsWith(DIR + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : path.join(DIR, 'index.html');
  res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream'); fs.createReadStream(file).pipe(res); }).listen(4611, '127.0.0.1');
const norm = (t) => t.replace(/\s+/g, ' ').trim();
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' }); const blocked = [];
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.route('**/*', (r) => { const u = r.request().url(); const h = u.startsWith('http') ? new URL(u).hostname : '127.0.0.1'; if (h === '127.0.0.1') return r.fallback(); blocked.push(u); return r.abort(); });
  const p = await ctx.newPage(); p.on('pageerror', (e) => ok(false, `page error: ${e.message}`)); p.on('dialog', (d) => d.dismiss());
  const shot = (n, full = true) => p.screenshot({ path: `${OUT}/shots/${n}.png`, fullPage: full }); const wait = (ms = 700) => p.waitForTimeout(ms);
  const tab = async (n) => { await p.locator('.top nav button', { hasText: new RegExp(`^${n}$`) }).click(); await wait(900); };
  await p.goto('http://127.0.0.1:4611/'); await wait(1800);

  ok(norm(await p.locator('.top nav').innerText()).toUpperCase() === 'DASHBOARD CALENDAR LABELING RECEIVING PUT-AWAY FLOOR PALLETS FIFO CYCLE COUNTS CONNECTIONS', `tabs: ${norm(await p.locator('.top nav').innerText())}`);
  ok((await p.locator('h1').innerText()).toUpperCase() === 'DASHBOARD', 'first page is Dashboard');
  ok(/Orbitron/.test(await p.locator('h1').evaluate((n) => getComputedStyle(n).fontFamily)) && await p.evaluate(() => document.fonts.check('800 26px "Orbitron"')), 'titles use the logo lettering (font loaded)');
  ok(/^Arial/.test(await p.locator('.glance small').first().evaluate((n) => getComputedStyle(n).fontFamily)) && (await p.locator('.glance small').first().evaluate((n) => getComputedStyle(n).fontWeight)) === '700', 'subtext is bold Arial');
  const g = norm(await p.locator('[data-testid=glance]').innerText()); ok(/^15 Pallets stored 2 Waiting for put-away 1 On hold 26 Pallets arriving in 7 days$/.test(g), `dashboard counts: ${g}`);
  ok((await p.locator('[data-testid=mini-map] .cell.full').count()) === 15, 'dashboard mini map shows the 15 occupied positions');
  ok(/21%/.test(await p.locator('[data-testid=ring]').innerText()) && /Free\s*57/.test(await p.locator('[data-testid=ring]').innerText()), `capacity ring: ${norm(await p.locator('[data-testid=ring]').innerText())}`);
  ok((await p.locator('[data-testid=calendar] .d.has').count()) >= 3, 'dashboard calendar marks the days with shipments'); await shot('1-dashboard');

  await tab('Calendar'); const d2 = new Date(); d2.setDate(d2.getDate() + 2); const k2 = `${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, '0')}-${String(d2.getDate()).padStart(2, '0')}`;
  if (d2.getMonth() !== new Date().getMonth() && (await p.locator(`[data-testid="day-${k2}"]`).count()) === 0) { await p.getByLabel('Next month').click(); await wait(); }
  await p.locator(`[data-testid="day-${k2}"]`).click(); await wait(400); ok((await p.locator('[data-testid=ship-row]').count()) === 2, 'calendar: the day shows its two booked shipments');
  await p.getByRole('button', { name: 'Book a shipment for this day' }).click(); await p.getByLabel('Reference').fill('Local test booking'); await wait(500); await p.locator('[data-testid=ship-items]').getByLabel('Item').selectOption({ index: 1 }); await p.getByLabel('Units expected').fill('240'); await p.locator('[data-testid=ship-form] input[type=number]').first().fill('5'); await p.getByRole('button', { name: 'Book it' }).click(); await wait(1000);
  ok((await p.locator('[data-testid=ship-row]').count()) === 3 && /240 × /.test(await p.locator('.calwrap aside').innerText()), 'calendar: a shipment is booked from Nexus with what is on it'); await shot('2-calendar');

  await tab('Labeling'); ok((await p.locator('[data-testid=label-table] tbody tr').count()) > 100, 'labeling: every pallet and carton label is on file');
  await p.getByLabel('Kind').selectOption('pallet'); await wait(900); ok((await p.locator('[data-testid=label-table] tbody tr').count()) === 18, 'labeling: 18 pallet labels');
  await p.locator('[data-testid=label-table] tbody tr').first().click(); await wait(1200); ok((await p.locator('[data-testid=label-detail] .labelview .plabel svg').count()) === 1 && /Nexus/.test(await p.locator('[data-testid=label-detail] .plabel footer').innerText()), 'labeling: a stored label opens as the real 4 x 6 pallet label, drawn by Nexus'); await shot('3-labeling');

  await tab('Floor'); ok((await p.locator('h1').innerText()).toUpperCase() === 'FLOOR', 'Locations is now Floor');
  await p.locator('[data-testid="cell-P-03"]').click(); await wait(900); const det = norm(await p.locator('[data-testid=cell-detail]').innerText());
  ok(/Position P-03/i.test(det) && /Sample Records/.test(det) && /carton labels on file/.test(det) && /History of this position/i.test(det), 'floor: a position shows its pallet, labels and history'); await shot('4-floor-position');
  const psku = (await p.locator('[data-testid=pos-pallet] .code').first().innerText()).trim();
  await p.getByRole('button', { name: 'Move', exact: true }).click(); await wait(300); ok((await p.locator('.cell.drop').count()) > 50, 'floor: moving lights up the free positions');
  ok(await p.locator('[data-testid="cell-P-05"]').isDisabled(), 'floor: a position that holds a pallet cannot be picked');
  await p.getByLabel('Move reason').fill('Clearing the dock lane'); await shot('5-floor-moving'); await p.locator('[data-testid="cell-P-10"]').click(); await wait(1200);
  ok(new RegExp(`${psku} moved to P-10 \\(was P-03\\)`).test(await p.locator('[data-testid=msg]').innerText()), 'floor: pallet moved by clicking the new position');
  ok((await p.locator('[data-testid="cell-P-10"]').getAttribute('class')).includes('full') && !(await p.locator('[data-testid="cell-P-03"]').getAttribute('class')).includes('full'), 'floor: the map shows it in the new position');
  await p.getByRole('button', { name: 'Override details' }).click(); await p.locator('[data-testid=pallet-editor] input[type=number]').first().fill('11'); await p.locator('[data-testid=pallet-editor]').getByLabel('Reason').fill('Recount'); await p.getByRole('button', { name: 'Save override' }).click(); await wait(1200);
  ok(/Cartons\s*11/i.test(norm(await p.locator('[data-testid=pos-pallet]').innerText())), 'floor: an admin override changes what the WMS entered');
  const log = norm(await p.locator('[data-testid=floor-log] tbody').innerText()); ok(/Details changed · Cartons 12 → 11 Recount Test Admin Nexus/.test(log) && /Moved · P-03 → P-10 Clearing the dock lane/.test(log), 'floor log records the move and the override with reasons');
  await p.getByRole('button', { name: 'Put away on the map' }).first().click(); await wait(300); await p.locator('[data-testid="cell-P-17"]').click(); await wait(1200); ok(/put away at P-17/.test(await p.locator('[data-testid=msg]').innerText()), 'floor: a waiting pallet is put away from the map');
  await p.getByLabel('New positions').fill('P-73..P-76'); await p.getByRole('button', { name: 'Add positions' }).click(); await wait(1200); ok((await p.locator('.extra .cell').count()) === 4, 'floor: positions added and shown'); await shot('6-floor');

  await tab('Receiving'); ok((await p.locator('[data-testid=recv-brands] button').count()) === 3, 'receiving: asks who the shipment is for');
  await p.locator('[data-testid=recv-brands] button', { hasText: 'Sample Sneakers' }).click(); await wait(900); await shot('14-receiving-shipments');
  await p.locator('[data-testid=recv-ship]', { hasText: 'Runner restock' }).getByRole('button', { name: 'Receive' }).click(); await wait(600);
  ok(/288 units/i.test(await p.locator('main').innerText()), 'receiving: what is in the shipment comes from the booking');
  const frame = async () => p.locator('#wms-print').evaluate((f) => ({ pages: (f.srcdoc.match(/class="(plabel|cpage|jack)"/g) || []).length, size: f.dataset.size, html: f.srcdoc })).catch(() => null);
  ok(/Enter the cartons/i.test(await p.locator('[data-testid=recv-form] .btn.big').innerText()), 'receiving: the button says what is missing');
  await p.getByLabel('Cartons').fill('12'); await p.getByLabel('Units per carton').fill('6'); await p.getByLabel('Pallets like this').fill('3'); await wait(300);
  ok((await p.locator('[data-testid=recv-labels] .labelview').count()) === 2 && /PSKU-______/.test(await p.locator('[data-testid=recv-labels]').innerText()), 'receiving: live preview of the pallet and carton label');
  await p.getByRole('button', { name: /Print carton labels now/ }).click(); await wait(1500); let fr = await frame();
  const heldTxt = await p.locator('[data-testid=recv-labels] .strip.ok').innerText(); const held = heldTxt.match(/PSKU-\d{6}/g) || [];
  ok(held.length === 3 && fr?.pages === 36 && fr.html.includes(`C${held[0].slice(5)}01`), `receiving: carton labels printed before Receive on held pallet numbers (${held.join(', ')}; ${fr?.pages} labels)`);
  await p.locator('[data-testid=recv-form] .btn.big').click(); await wait(1800);
  ok((await p.locator('[data-testid=recv-pallet]').count()) === 3 && new RegExp(`3 pallets received: ${held.join(', ')}`).test(await p.locator('[data-testid=msg]').innerText()), 'receiving: 3 pallets received under the numbers already on their labels');
  ok(/printed before receiving/.test(await p.locator('[data-testid=recv-print]').innerText()), 'receiving: the early labels were checked against what the database made');
  await p.locator('[data-testid=recv-print]').getByRole('button', { name: 'Print', exact: true }).click(); await wait(1200); fr = await frame();
  ok(fr?.pages === 3 && fr.size === '4in 6in' && fr.html.includes('<span>Nexus</span>'), 'receiving: 4 x 6 pallet labels are drawn and printed by Nexus'); await shot('15a-receiving-labels');
  await p.getByRole('button', { name: /next pallet/ }).click(); await wait(300);
  // last pallet: mixed, with an FBA line, a product from outside the booking list is not needed; add an NCC line that is not on the list
  await p.getByLabel('Cartons').fill('8'); await p.getByLabel('Units per carton').fill('6'); await p.locator('[data-testid=recv-line] .chk', { hasText: 'FBA' }).click();
  await p.getByRole('button', { name: '+ Another product on this pallet' }).click(); await wait(200); await p.locator('[data-testid=recv-line]').nth(1).getByLabel('Product').selectOption('__off'); await p.getByLabel('Product name').fill('Loose shoe boxes'); await p.locator('[data-testid=recv-line]').nth(1).locator('.chk', { hasText: 'NCC' }).click();
  await p.getByLabel('After this').selectOption('final'); await wait(300); await shot('15b-receiving-mixed');
  ok(/Receive 1 mixed pallet · 8 cartons/i.test(await p.locator('[data-testid=recv-form] .btn.big').innerText()), 'receiving: a mixed pallet with an FBA line and an NCC line that is not on the list');
  await p.locator('[data-testid=recv-form] .btn.big').click(); await wait(1800);
  ok((await p.locator('[data-testid=recv-pallet]').count()) === 4 && /Mixed pallet · 2 products/.test(await p.locator('[data-testid=recv-pallet]').last().innerText()), 'receiving: the mixed pallet is on file'); await p.getByRole('button', { name: /next pallet/ }).click();
  ok(await p.getByRole('button', { name: 'Complete receiving' }).isDisabled(), 'receiving: cannot be completed before put-away');
  const got = await p.locator('[data-testid=recv-pallet] .code').allInnerTexts(); const spots = ['P-62', 'P-63', 'P-64', 'P-65'];
  for (let i = 0; i < 4; i++) { await p.locator('[data-testid=recv-put]').getByLabel('Pallet').fill(got[i]); await p.locator('[data-testid=recv-put]').getByLabel('Position').fill(spots[i]); await p.getByRole('button', { name: 'Put away', exact: true }).click(); await wait(900); }
  await wait(600); await shot('15-receiving'); await p.getByRole('button', { name: 'Complete receiving' }).click(); await wait(1200);
  ok(/received with differences \(4 of 4 pallets, 44 of 48 cartons\)\. Sample Sneakers's WMS shows the difference/.test(await p.locator('[data-testid=msg]').innerText()) && (await p.locator('[data-testid=recv-done]').count()) === 1, 'receiving: completed; the carton shortfall against the booking is reported to the WMS'); await shot('16-receiving-done');
  await tab('Put-away'); const wp = (await p.locator('[data-testid=putaway-table] tbody tr .code').first().innerText()).trim(); await p.locator('[data-testid=scan-pallet]').fill(wp); await p.keyboard.press('Enter'); await wait(400); await p.locator('[data-testid=scan-position]').fill('LOC-P-71'); await p.keyboard.press('Enter'); await wait(1200);
  ok(new RegExp(`${wp} is in P-71`).test(await p.locator('[data-testid=putaway-msg]').innerText()), 'put-away tab: scan the pallet, scan the position code');
  await tab('Floor'); await p.locator('[data-testid=jack-sheet]').click(); await wait(1200); const js = await p.locator('#wms-print').evaluate((f) => ({ pages: (f.srcdoc.match(/class="jack"/g) || []).length, codes: (f.srcdoc.match(/class="p"/g) || []).length, size: f.dataset.size }));
  ok(js.pages === 4 && js.codes === 78 && js.size === '8.5in 11in', `floor: pallet-jack scan sheet, every position with its barcode (${js.codes} on ${js.pages} letter pages)`);
  await tab('Pallets'); ok((await p.locator('[data-testid=pallet-table] tbody tr').count()) === 22, 'pallets: all 22 listed'); await shot('7-pallets');
  await p.locator('[data-testid=pallet-table] tbody tr', { hasText: psku }).click(); await wait(1000);
  const facts = norm(await p.locator('[data-testid=pallet-facts]').innerText()); ok(/Cartons scanned\s*12 of 12/i.test(facts) && /Received/i.test(facts) && (await p.locator('[data-testid=pallet-admin] button').count()) === 3, 'pallet page: full details and the three admin actions'); await shot('8-pallet');
  await p.locator('.back').click(); await wait(600);
  await tab('FIFO'); ok(/under construction/i.test(await p.locator('[data-testid=construction]').innerText()), 'FIFO says it is under construction'); await shot('9-fifo', false);

  await tab('Connections'); await p.getByLabel('WMS name').fill('Sample Sneakers WMS'); await p.locator('section:has-text("Connect a site") .checks label', { hasText: 'Sample Sneakers' }).click(); await p.getByRole('button', { name: 'Create both keys' }).click(); await wait(1200);
  const fk = (await p.locator('[data-testid=key-floor] code').first().innerText()).trim(), ak = (await p.locator('[data-testid=key-admin] code').first().innerText()).trim(); ok(/^nxs_[0-9a-f]{64}$/.test(fk) && /^nxs_[0-9a-f]{64}$/.test(ak) && fk !== ak, 'connections: a floor key and an admin key, each shown once');
  await p.locator('[data-testid=new-keys] code').evaluateAll((ns) => ns.forEach((n) => { n.textContent = n.textContent.replace(/nxs_[0-9a-f]{64}/, 'nxs_••••••••••••••••••••••••'); })); await shot('10-connections');
  await p.getByRole('button', { name: 'Change permissions' }).click(); await p.locator('[data-testid=connection] .perms > div').first().locator('label', { hasText: 'Scan pallets' }).click(); await p.getByRole('button', { name: 'Save permissions' }).click(); await wait(1000);
  ok((await p.locator('[data-testid=connection] .perms.read > div').first().locator('.no').count()) === 1, 'connections: a permission can be switched off per key');

  const w = await ctx.newPage(); w.on('pageerror', (e) => ok(false, `window page error: ${e.message}`));
  await w.goto(`http://127.0.0.1:4611/?window=floor#k=${fk}`); await w.waitForTimeout(1800);
  ok((await w.locator('.wintop nav button').count()) === 1 && (await w.locator('[data-testid=win-scan]').count()) === 0, 'floor window: floor only, and no scanning once that permission is off');
  ok((await w.locator('.cell.taken').count()) > 5 && (await w.locator('.cell.full').count()) >= 5, 'floor window: own pallets in colour, other brands only as in use'); await w.screenshot({ path: `${OUT}/shots/11-window-floor.png`, fullPage: true });
  await w.goto('about:blank'); await w.goto(`http://127.0.0.1:4611/?window=admin#k=${ak}`); await w.waitForTimeout(1800);
  ok(norm(await w.locator('.wintop nav').innerText()).toUpperCase() === 'FLOOR CALENDAR LABELS', 'admin window: floor, calendar and labels');
  const mine = (await w.locator('[data-testid=unplaced] .link').count()) ? null : null; const own = await w.locator('.cell.full').first().getAttribute('title'); const ownPsku = own.split(' · ')[2];
  await w.getByLabel('Pallet').fill(ownPsku); await w.getByLabel('Position').fill('P-70'); await w.getByRole('button', { name: 'Put it there' }).click(); await w.waitForTimeout(1200);
  ok(/moved to P-70/.test(await w.locator('[data-testid=msg]').innerText()), 'admin window: a scan moves its own pallet'); await w.screenshot({ path: `${OUT}/shots/12-window-admin.png`, fullPage: true });
  await p.bringToFront(); await tab('Floor'); await wait(600); ok((await p.locator('[data-testid="cell-P-70"]').getAttribute('class')).includes('full'), 'the scan made in the window shows on the Nexus floor'); 
  ok(/Sample Sneakers WMS \(admin window\)/.test(await p.locator('[data-testid=floor-log] tbody').innerText()), 'and the floor log names the window it came through');
  await w.bringToFront(); await w.locator('.wintop nav button', { hasText: /^Calendar$/ }).click(); await w.waitForTimeout(1000); await w.screenshot({ path: `${OUT}/shots/13-window-calendar.png`, fullPage: true });
  ok((await w.locator('[data-testid=calendar] .ship').count()) >= 1 && !/Sample Records/.test(await w.locator('[data-testid=calendar]').innerText()), 'admin window calendar: only its own brand');
  await w.goto('about:blank'); await w.goto('http://127.0.0.1:4611/?window=admin#k=nxs_wrong'); await w.waitForTimeout(1200); ok(/not recognised/.test(await w.locator('body').innerText()), 'a wrong key shows nothing');

  const f = await ctx.newPage(); await f.goto('http://127.0.0.1:4611/?as=floor'); await f.waitForTimeout(1500); ok(!/CONNECTIONS/i.test(await f.locator('.top nav').innerText()), 'a floor login has no Connections tab');
  await f.locator('.top nav button', { hasText: /^Floor$/ }).click(); await f.waitForTimeout(900); await f.locator('[data-testid="cell-P-10"]').click(); await f.waitForTimeout(800);
  ok((await f.getByRole('button', { name: 'Move', exact: true }).count()) === 0 && (await f.getByRole('button', { name: 'Override details' }).count()) === 0, 'a floor login sees the floor but has no move or override');
  ok(blocked.length === 0, `requests outside 127.0.0.1: ${blocked.length} ${blocked.slice(0, 2).join(' ')}`);
  await browser.close(); server.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
