// The Nexus website's read-only view. Separate from the integration API: no Nexus key is involved and nothing can be written.
// The website has no login of its own; it uses the warehouse's existing staff sign-in. A request carries that signed-in user's
// short-lived token, which is checked with the sign-in service on every new token (and for 60 seconds after), together with the
// user's role. Answers hold company, position and time only: never a pallet id, a reference or a note.
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-max-age': '600' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS } });
export function makeSite(query, { authUrl, anonKey, floor, roles, fetchImpl = fetch, now = () => Date.now(), onError = () => {} }) {
  const seen = new Map();   // token -> { until, ok }
  const allowed = async (token) => {
    const hit = seen.get(token); if (hit && hit.until > now()) return hit.ok;
    const h = { apikey: anonKey, authorization: `Bearer ${token}` }; let ok = false;
    const u = await fetchImpl(`${authUrl}/auth/v1/user`, { headers: h });
    if (u.status === 200) {
      const id = (await u.json())?.id;
      if (typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)) {
        const p = await fetchImpl(`${authUrl}/rest/v1/profiles?id=eq.${id}&select=role,active`, { headers: h });
        const row = p.status === 200 ? (await p.json())?.[0] : null; ok = !!row && row.active === true && roles.includes(row.role) ? true : 'forbidden';
      }
    }
    if (seen.size > 500) seen.clear(); seen.set(token, { until: now() + 60000, ok }); return ok;
  };
  return async function site(req) {
    const url = new URL(req.url); const path = url.pathname.replace(/\/+$/, '');
    if (!path.startsWith('/site/')) return null;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'GET' || path !== '/site/v1/overview') return json({ ok: false, error: 'not_found', message: 'unknown path' }, 404);
    const token = (req.headers.get('authorization') || '').match(/^Bearer\s+([A-Za-z0-9._-]{20,4000})$/)?.[1];
    if (!token) return json({ ok: false, error: 'unauthorized', message: 'sign in first' }, 401);
    try {
      const ok = await allowed(token);
      if (ok === 'forbidden') return json({ ok: false, error: 'forbidden', message: 'this login cannot use Nexus' }, 403);
      if (!ok) return json({ ok: false, error: 'unauthorized', message: 'sign in again' }, 401);
      const r = (await query('select nexus.site_overview($1::text) r', [floor]))[0].r; return json(r, r.ok ? 200 : 404);
    } catch (e) { onError(String(e?.message || e).slice(0, 300)); return json({ ok: false, error: 'unavailable', message: 'Nexus could not answer.' }, 503); }
  };
}
