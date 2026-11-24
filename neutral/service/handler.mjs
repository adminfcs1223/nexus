// Nexus integration service, version 1. One function: a web Request in, a web Response out. It holds no state and no
// secrets: a system's key arrives in the Authorization header, is passed to the database, and only its hash exists there.
// `query(sql, params)` is supplied by whatever hosts this (Node today; any runtime with fetch-style handlers later).
export const VERSION = '1.1.0';
const STATUS = { unauthorized: 401, forbidden: 403, bad_request: 400, location_not_confirmed: 400, pallet_not_found: 404, location_not_found: 404, not_found: 404,
  occupancy_not_initialized: 423, unavailable: 503 };   // every other refusal is a 409: the request was understood and the floor says no
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-nexus-api': VERSION, ...extra } });
const answer = (r) => json(r, r.ok ? 200 : STATUS[r.error] || 409);
const fail = (error, message) => answer({ ok: false, error, message });

// Every value travels to the database as text and is cast there, so the answer does not depend on which driver hosts this.
export function makeHandler(query, onError = () => {}) {
  const call = async (fn, args, types = []) => (await query(`select nexus.${fn}(${args.map((_, i) => `$${i + 1}::text${types[i] ? `::${types[i]}` : ''}`).join(', ')}) r`, args.map((v) => (v == null ? null : String(v)))))[0].r;
  return async function handle(req) {
    const url = new URL(req.url); const path = url.pathname.replace(/\/+$/, ''); const m = req.method;
    if (path === '/v1/health' && m === 'GET') return json({ ok: true, service: 'nexus', api: VERSION });
    if (!path.startsWith('/v1/')) return fail('not_found', 'unknown path; the API lives under /v1');
    if ([...url.searchParams.keys()].some((k) => /key|token|secret/i.test(k))) return fail('bad_request', 'a key never goes in the address; send it in the Authorization header');
    const key = (req.headers.get('authorization') || '').match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!key) return json({ ok: false, error: 'unauthorized', message: 'send Authorization: Bearer <key>' }, 401, { 'www-authenticate': 'Bearer' });
    let body = {};
    if (m === 'POST' || m === 'PUT') {
      const text = await req.text(); if (text.length > 16384) return fail('bad_request', 'the request body is too large');
      try { body = text ? JSON.parse(text) : {}; } catch { return fail('bad_request', 'the body is not valid JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('bad_request', 'the body is a JSON object');
    }
    const s = (v) => (v == null ? null : String(v)); const q = (k) => url.searchParams.get(k); const int = (k) => (q(k) != null && /^\d+$/.test(q(k)) ? Number(q(k)) : null);
    const when = (k) => { const v = q(k); return v == null ? null : Number.isNaN(Date.parse(v)) ? undefined : v; };
    try {
      if (m === 'GET' && path === '/v1/map') return answer(await call('api_map', [key]));
      if (m === 'GET' && path === '/v1/occupancy') return answer(await call('api_occupancy', [key]));
      if (m === 'GET' && path === '/v1/changes') return answer(await call('api_changes', [key, int('after') ?? 0, int('limit') ?? 200], [, 'bigint', 'integer']));
      if (m === 'GET' && path === '/v1/moves') return answer(await call('api_moves', [key, q('pallet'), int('before'), int('limit') ?? 200], [, , 'bigint', 'integer']));
      const act = m === 'POST' && path.match(/^\/v1\/pallets\/(assign|move|release)$/)?.[1];
      if (act && ('confirmed_empty' in body || 'confirmed_by' in body)) return answer(await call('api_place_confirmed', [key, act, s(body.pallet), s(body.to), s(body.from), req.headers.get('idempotency-key'), body.confirmed_empty === true ? 'true' : '', s(body.confirmed_by)]));
      if (act) return answer(await call('api_place', [key, act, s(body.pallet), s(body.to), s(body.from), req.headers.get('idempotency-key')]));
      if (m === 'GET' && path === '/v1/calendar') {
        const from = when('from'), to = when('to'); if (from === undefined || to === undefined) return fail('bad_request', 'from and to are dates with their offset');
        return answer(await call('api_calendar', [key, from, to], [, 'timestamptz', 'timestamptz']));
      }
      const ev = path.match(/^\/v1\/calendar\/([^/]{1,64})$/)?.[1];
      if (ev && m === 'PUT') return answer(await call('api_calendar_put', [key, decodeURIComponent(ev), JSON.stringify(body)], [, , 'jsonb']));
      if (ev && m === 'DELETE') return answer(await call('api_calendar_put', [key, decodeURIComponent(ev), JSON.stringify({ status: 'cancelled' })], [, , 'jsonb']));
      return fail('not_found', 'unknown path or method');
    } catch (e) {
      onError(String(e?.message || e).slice(0, 300));
      return fail('unavailable', 'Nexus could not answer. Nothing was changed; send the same request again with the same Idempotency-Key.');   // the cause is never sent to the caller
    }
  };
}
