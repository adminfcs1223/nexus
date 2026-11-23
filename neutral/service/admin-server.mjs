// Runs the administrator service on Node, bound to 127.0.0.1 only. Not for public hosting as it stands: put it behind
// a TLS-terminating proxy on a private network, list that proxy in NEXUS_ADMIN_PROXIES and the operators' networks in
// NEXUS_ADMIN_ALLOW. The database login must be a member of nexus_admin_api and nothing else.
//   NEXUS_ADMIN_DB=postgres://<login>@… NEXUS_ADMIN_MODE=synthetic NEXUS_ADMIN_FLOORS=REHEARSAL-01 NEXUS_ADMIN_ALLOW=127.0.0.1/32 PORT=8788 node neutral/service/admin-server.mjs
import http from 'node:http'; import pg from 'pg'; import { makeAdminHandler } from './admin.mjs';
export function serveAdmin(connectionString, options, port = 0) {
  const pool = new pg.Pool({ connectionString, max: 5, statement_timeout: 10000, idle_in_transaction_session_timeout: 10000 });
  const handle = makeAdminHandler(async (sql, p) => (await pool.query(sql, p)).rows, options);
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000, keepAliveTimeout: 5000 }, async (req, res) => {
    try {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 300000) { res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"bad_request"}'); req.destroy(); return; } chunks.push(c); }
      const r = await handle(new Request(`http://${req.headers.host || 'localhost'}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), { remote: req.socket.remoteAddress });
      res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(await r.text());
    } catch { if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"bad_request"}'); }
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}`, pool, close: () => new Promise((d) => { server.closeAllConnections?.(); server.close(() => pool.end().then(d)); }) })));
}
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
if (import.meta.url === `file://${process.argv[1]}`) serveAdmin(process.env.NEXUS_ADMIN_DB, { mode: process.env.NEXUS_ADMIN_MODE, floors: list(process.env.NEXUS_ADMIN_FLOORS), allow: list(process.env.NEXUS_ADMIN_ALLOW), trustedProxies: list(process.env.NEXUS_ADMIN_PROXIES) }, Number(process.env.PORT || 8788)).then((s) => console.log(`Nexus admin service on ${s.url}`));
