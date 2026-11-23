// Nexus administrator controls: a separate handler from the integration service, with its own address and its own database
// role. It is never mounted on the public integration service. One function: a web Request in, a web Response out.
//
// An operator's token arrives in the Authorization header and is passed to the database, which decides everything: who the
// operator is, which roles they hold, which floors they are assigned to. This file adds one rule of its own, checked before
// the database is asked anything: in 'synthetic' mode it serves only the rehearsal floors it was started with, and it
// refuses to start at all if any of them is not a REHEARSAL- floor.
export const ADMIN_VERSION = '1.0.0-draft';
const STATUS = { unauthorized: 401, forbidden: 403, wrong_floor: 403, synthetic_operator: 403, rehearsal_floor: 403, not_independent: 403, floor_not_allowed: 403,
  warehouse_not_found: 404, baseline_not_found: 404, location_not_found: 404, not_found: 404, not_open: 404,
  bad_request: 400, confirmation_required: 400, backup_required: 400, not_a_passed_report: 400, unavailable: 503 };   // any other refusal: 409
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-nexus-admin': ADMIN_VERSION } });
const answer = (r) => json(r, r.ok ? 200 : STATUS[r.error] || 409); const fail = (error, message) => answer({ ok: false, error, message });
const REHEARSAL = /^REHEARSAL-[A-Z0-9]{1,12}$/; const FLOOR = /^[A-Z0-9-]{2,24}$/; const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function makeAdminHandler(query, { mode, floors, onError = () => {} } = {}) {
  if (mode !== 'synthetic' && mode !== 'live') throw new Error('the admin service needs a mode: synthetic or live');
  if (!Array.isArray(floors) || floors.length === 0) throw new Error('the admin service needs the list of floors it serves');
  if (mode === 'synthetic' && floors.some((f) => !REHEARSAL.test(f))) throw new Error('in synthetic mode the admin service serves REHEARSAL- floors only');
  if (mode === 'live' && floors.some((f) => REHEARSAL.test(f))) throw new Error('in live mode the admin service does not serve rehearsal floors');
  const allowed = new Set(floors);
  const call = async (fn, args, types = []) => (await query(`select nexus.${fn}(${args.map((_, i) => `$${i + 1}::text${types[i] ? `::${types[i]}` : ''}`).join(', ')}) r`, args.map((v) => (v == null ? null : String(v)))))[0].r;
  return async function handle(req) {
    const url = new URL(req.url); const path = url.pathname.replace(/\/+$/, ''); const m = req.method;
    if (m === 'GET' && path === '/admin/v1/health') return json({ ok: true, service: 'nexus-admin', api: ADMIN_VERSION, mode, floors });
    const mt = path.match(/^\/admin\/v1\/floors\/([^/]+)(\/.*)?$/);
    if (!mt) return fail('not_found', 'unknown path');
    const floor = decodeURIComponent(mt[1]); const rest = mt[2] || '';
    // the floor is in the address of every call, and is checked here before anything else happens
    if (!FLOOR.test(floor) || !allowed.has(floor)) return fail('floor_not_allowed', `this administrator service (${mode} mode) does not act on that floor`);
    if ([...url.searchParams.keys()].some((k) => /key|token|secret/i.test(k))) return fail('bad_request', 'a token never goes in the address; send it in the Authorization header');
    const token = (req.headers.get('authorization') || '').match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) return json({ ok: false, error: 'unauthorized', message: 'send Authorization: Bearer <operator token>' }, 401);
    let body = {};
    if (m === 'POST') {
      const text = await req.text(); if (text.length > 262144) return fail('bad_request', 'the request body is too large');
      try { body = text ? JSON.parse(text) : {}; } catch { return fail('bad_request', 'the body is not valid JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('bad_request', 'the body is a JSON object');
    } else if (m !== 'GET') return fail('not_found', 'unknown method');
    const s = (v) => (v == null ? null : String(v));
    try {
      if (m === 'GET' && rest === '/status') return answer(await call('floor_status', [token, floor]));
      if (m === 'POST' && rest === '/baselines') return answer(await call('baseline_submit', [token, floor, JSON.stringify(body.report ?? null)], [, , 'jsonb']));
      const b = rest.match(/^\/baselines\/([^/]+)(\/[a-z]+)?$/);
      if (b) {
        const id = b[1]; if (!UUID.test(id)) return fail('baseline_not_found', 'no such baseline on this floor');
        // every baseline action first proves the baseline belongs to the floor in the address (and that this operator may see it)
        const review = await call('baseline_review', [token, floor, id], [, , 'uuid']);
        if (m === 'GET' && !b[2]) return answer(review);
        if (!review.ok) return answer(review);
        if (m === 'POST' && b[2] === '/approve') return answer(await call('baseline_approve', [token, id, s(body.fingerprint)], [, 'uuid']));
        if (m === 'POST' && b[2] === '/reject') return answer(await call('baseline_reject', [token, id, s(body.reason)], [, 'uuid']));
        if (m === 'POST' && b[2] === '/initialize') return answer(await call('baseline_initialize', [token, id, s(body.fingerprint), s(body.backup)], [, 'uuid']));
        if (m === 'POST' && b[2] === '/revert') return answer(await call('baseline_revert', [token, id, s(body.reason)], [, 'uuid']));
        return fail('not_found', 'unknown path');
      }
      if (m === 'POST' && rest === '/unlock-approval') return answer(await call('floor_unlock_approve', [token, floor]));
      if (m === 'POST' && rest === '/unlock') return answer(await call('floor_unlock', [token, floor, s(body.confirm)]));
      if (m === 'POST' && rest === '/stop') return answer(await call('floor_stop', [token, floor, s(body.reason)]));
      if (m === 'POST' && rest === '/capacity') return answer(await call('location_capacity_verify', [token, floor, s(body.position), Number.isInteger(body.capacity) ? body.capacity : null, s(body.specification)], [, , , 'integer']));
      if (m === 'POST' && rest === '/discrepancies') return answer(await call('discrepancy_open', [token, floor, s(body.position), s(body.kind), s(body.detail)]));
      const d = m === 'POST' && rest.match(/^\/discrepancies\/(\d{1,12})\/resolve$/);
      if (d) {
        // the discrepancy must be one of this floor's open ones
        const st = await call('floor_status', [token, floor]); if (!st.ok) return answer(st);
        if (!st.open_discrepancies.some((x) => String(x.id) === d[1])) return fail('not_open', 'no open discrepancy with that number on this floor');
        return answer(await call('discrepancy_resolve', [token, d[1], s(body.resolution)], [, 'bigint']));
      }
      return fail('not_found', 'unknown path');
    } catch (e) { onError(String(e?.message || e).slice(0, 300)); return fail('unavailable', 'The control could not be completed. Check the floor status before trying again.'); }
  };
}
