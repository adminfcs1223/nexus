// Runs the administrator controls on Node, bound to 127.0.0.1 only. Not for public hosting as it stands.
//   NEXUS_ADMIN_DB=postgres://<role in nexus_admin_api>@… NEXUS_ADMIN_MODE=synthetic NEXUS_ADMIN_FLOORS=REHEARSAL-01 PORT=8788 node neutral/service/admin-server.mjs
import http from 'node:http'; import pg from 'pg'; import { makeAdminHandler } from './admin.mjs';
export function serveAdmin(connectionString, options, port = 0) {
  const pool = new pg.Pool({ connectionString, max: 5 }); const handle = makeAdminHandler(async (sql, p) => (await pool.query(sql, p)).rows, options);
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(await r.text());
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}`, pool, close: () => new Promise((d) => server.close(() => pool.end().then(d))) })));
}
if (import.meta.url === `file://${process.argv[1]}`) serveAdmin(process.env.NEXUS_ADMIN_DB, { mode: process.env.NEXUS_ADMIN_MODE, floors: String(process.env.NEXUS_ADMIN_FLOORS || '').split(',').map((s) => s.trim()).filter(Boolean) }, Number(process.env.PORT || 8788)).then((s) => console.log(`Nexus admin controls on ${s.url}`));
