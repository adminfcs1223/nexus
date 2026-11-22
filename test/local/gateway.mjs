// Stand-in for Supabase's /rest/v1/rpc in front of the local synthetic database (127.0.0.1 only). The bearer token names the
// synthetic login ("admin" or "floor"); nexus_api_* calls always run as anon, the way a key window reaches them.
import http from 'node:http'; import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgres://postgres@127.0.0.1:54318/nexuslocal', max: 4 });
const USERS = { admin: 'aa000000-0000-4000-8000-000000000002', floor: 'aa000000-0000-4000-8000-000000000001' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'content-type': 'application/json' };
const meta = new Map();
const lookup = async (fn) => { if (!meta.has(fn)) { const r = await pool.query(`select p.proretset, p.prorettype::regtype::text ret, coalesce(p.proargnames, '{}') names, (select coalesce(array_agg(t::regtype::text order by o), '{}') from unnest(p.proargtypes) with ordinality x(t, o)) types from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`, [fn]); meta.set(fn, r.rows[0] || null); } return meta.get(fn); };
http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const m = new URL(req.url, 'http://x').pathname.match(/^\/rest\/v1\/rpc\/(nexus_[a-z_]+|wms_receive_booking|wms_products|wms_hold_pskus)$/); if (!m) { res.writeHead(404, CORS); return res.end('{"message":"not part of the local stack"}'); }
  let body = ''; for await (const c of req) body += c; const args = body ? JSON.parse(body) : {};
  const who = (req.headers.authorization || '').replace('Bearer ', ''); const api = m[1].startsWith('nexus_api_');
  const f = await lookup(m[1]).catch(() => null); if (!f) { res.writeHead(400, CORS); return res.end(JSON.stringify({ message: `function ${m[1]} does not exist` })); }   // before taking a connection: a lookup while holding one can starve the pool
  const c = await pool.connect();
  try {
    const keys = Object.keys(args); const call = `public.${m[1]}(${keys.map((k, i) => { const t = f.types[f.names.indexOf(k)]; if (!t) throw new Error(`no argument ${k}`); return `${k} => $${i + 1}::${t}`; }).join(', ')})`;
    const vals = keys.map((k) => { const t = f.types[f.names.indexOf(k)]; const v = args[k]; return v != null && (t === 'jsonb' || t === 'json') ? JSON.stringify(v) : v; });
    await c.query('begin'); await c.query(`set local role ${api || !USERS[who] ? 'anon' : 'authenticated'}`); await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(!api && USERS[who] ? { sub: USERS[who] } : {})]);
    const r = f.proretset ? (await c.query(`select * from ${call}`, vals)).rows : f.ret === 'void' ? (await c.query(`select ${call}`, vals), null) : (await c.query(`select ${call} as r`, vals)).rows[0].r;
    await c.query('commit'); res.writeHead(200, CORS); res.end(JSON.stringify(r ?? null));
  } catch (e) { await c.query('rollback').catch(() => {}); res.writeHead(400, CORS); res.end(JSON.stringify({ message: e.message })); } finally { c.release(); }
}).listen(54341, '127.0.0.1', () => console.log('READY'));
