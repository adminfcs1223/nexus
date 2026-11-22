// Runs the integration service on Node for local and staging use: NEXUS_DB=postgres://… PORT=8787 node neutral/service/server.mjs
import http from 'node:http'; import pg from 'pg'; import { makeHandler } from './handler.mjs';
export function serve(connectionString, port = 0) {
  const pool = new pg.Pool({ connectionString, max: 20 }); const handle = makeHandler(async (sql, p) => (await pool.query(sql, p)).rows);
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(await r.text());
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}`, pool, close: () => new Promise((d) => server.close(() => pool.end().then(d))) })));
}
if (import.meta.url === `file://${process.argv[1]}`) serve(process.env.NEXUS_DB, Number(process.env.PORT || 8787)).then((s) => console.log(`Nexus integration service on ${s.url}`));
