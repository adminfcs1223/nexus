// Nexus administrator service, hardened (2.0.0-draft). A separate handler from the integration service, with its own
// address and its own database login (a member of nexus_admin_api, which can run six functions and read no table).
// Not deployed anywhere. One function: a web Request plus the caller's network address in, a web Response out.
//
// Order of checks on every request, each refusal recorded:
//   1. the caller's network address is on the allow-list            (nothing else is even parsed for anyone else)
//   2. the request arrived over HTTPS                               (when requireHttps is on; always on in live mode)
//   3. request limits per address, then per kind of call
//   4. the floor in the address is one this service was started for
//   5. the database decides the rest: session, role, floor, fresh code. This file holds no secret and trusts no header
//      for identity.
import { BlockList, isIP } from 'node:net'; import { randomUUID, createHash } from 'node:crypto';
export const ADMIN_VERSION = '2.0.0-draft';
const STATUS = { unauthorized: 401, session_expired: 401, credential_expired: 401, mfa_not_enrolled: 401, not_enrolled: 401, forbidden: 403, mfa_required: 403, wrong_floor: 403, synthetic_operator: 403, rehearsal_floor: 403,
  not_independent: 403, floor_not_allowed: 403, network_not_allowed: 403, https_required: 403, locked: 423, rate_limited: 429,
  warehouse_not_found: 404, baseline_not_found: 404, location_not_found: 404, not_found: 404, not_open: 404,
  bad_request: 400, confirmation_required: 400, backup_required: 400, not_a_passed_report: 400, unavailable: 503 };   // any other refusal: 409
const REHEARSAL = /^REHEARSAL-[A-Z0-9]{1,12}$/; const FLOOR = /^[A-Z0-9-]{2,24}$/; const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DEFAULT_LIMITS = { perAddress: [120, 60], signIn: [5, 60], breakGlass: [5, 60], write: [20, 60], read: [60, 60] };   // [requests, seconds]

const family = (ip) => (isIP(ip) === 6 ? 'ipv6' : 'ipv4');
const plain = (ip) => String(ip || '').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
function blockList(entries, what) {
  const b = new BlockList();
  for (const e of entries) {
    const [ip, bits] = String(e).trim().split('/'); if (!isIP(ip)) throw new Error(`${what}: "${e}" is not an address or network`);
    const max = isIP(ip) === 6 ? 128 : 32; const n = bits === undefined ? max : Number(bits); if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`${what}: "${e}" has a bad prefix length`);
    if (n === 0) throw new Error(`${what}: "${e}" would admit every address`);
    b.addSubnet(ip, n, family(ip));
  }
  return b;
}

export function makeAdminHandler(query, { mode, floors, allow, trustedProxies = [], requireHttps = mode === 'live', limits = {}, now = () => Date.now(), onError = () => {} } = {}) {
  if (mode !== 'synthetic' && mode !== 'live') throw new Error('the admin service needs a mode: synthetic or live');
  if (!Array.isArray(floors) || floors.length === 0) throw new Error('the admin service needs the list of floors it serves');
  if (mode === 'synthetic' && floors.some((f) => !REHEARSAL.test(f))) throw new Error('in synthetic mode the admin service serves REHEARSAL- floors only');
  if (mode === 'live' && floors.some((f) => REHEARSAL.test(f))) throw new Error('in live mode the admin service does not serve rehearsal floors');
  if (!Array.isArray(allow) || allow.length === 0) throw new Error('the admin service needs the list of networks it accepts requests from; it has no default');
  if (mode === 'live' && !requireHttps) throw new Error('in live mode the admin service accepts HTTPS only');
  const allowed = new Set(floors); const nets = blockList(allow, 'allow'); const proxies = blockList(trustedProxies, 'trustedProxies'); const L = { ...DEFAULT_LIMITS, ...limits };
  const inList = (list, ip) => isIP(ip) !== 0 && list.check(ip, family(ip));
  // The caller's address: the socket's, unless the socket is one of OUR proxies, in which case the last address in
  // X-Forwarded-For that is not one of our proxies. A forwarded header from anyone else is ignored.
  const clientOf = (remote, xff) => {
    let ip = plain(remote); if (!inList(proxies, ip)) return ip;
    const hops = String(xff || '').split(',').map((s) => plain(s.trim())).filter(Boolean);
    while (hops.length) { ip = hops.pop(); if (!inList(proxies, ip)) return ip; }
    return ip;
  };
  // fixed-window counters, in this process's memory (see ADMIN.md: one instance only; several instances need a shared limiter)
  const windows = new Map();
  const over = (key, [max, seconds]) => {
    const t = now(); const w = windows.get(key);
    if (!w || t - w.start >= seconds * 1000) { windows.set(key, { start: t, n: 1 }); if (windows.size > 20000) for (const [k, v] of windows) if (t - v.start > 600000) windows.delete(k); return 0; }
    w.n += 1; return w.n > max ? Math.max(1, Math.ceil((w.start + seconds * 1000 - t) / 1000)) : 0;
  };
  // a refusal made here is written to the access log, at most once a minute per address and reason, with the count since
  const refusals = new Map();
  const note = (reason, client, path) => {
    const key = `${reason}|${client}`; const t = now(); const r = refusals.get(key);
    if (r && t - r.at < 60000) { r.n += 1; return; }
    refusals.set(key, { at: t, n: 0 }); if (refusals.size > 20000) refusals.clear();
    query('select nexus.admin_edge_refusal($1, $2, $3, $4)', [reason, client, path, (r?.n || 0) + 1]).catch((e) => onError(String(e?.message || e).slice(0, 300)));
  };
  const one = async (sql, args) => (await query(sql, args))[0].r;

  return async function handle(req, { remote } = {}) {
    const request = randomUUID(); const url = new URL(req.url); const path = url.pathname.replace(/\/+$/, ''); const m = req.method;
    const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'strict-transport-security': 'max-age=31536000', 'referrer-policy': 'no-referrer', 'x-nexus-admin': ADMIN_VERSION, 'x-request-id': request, ...extra } });
    const answer = (r) => json(r, r.ok ? 200 : STATUS[r.error] || 409, r.retry_after_seconds ? { 'retry-after': String(r.retry_after_seconds) } : {});
    const fail = (error, message, more = {}) => answer({ ok: false, error, message, ...more });
    const client = clientOf(remote, req.headers.get('x-forwarded-for'));
    if (!inList(nets, client)) { note('network_not_allowed', client || '(none)', path); return fail('network_not_allowed', 'not available from this network'); }
    if (requireHttps && !(url.protocol === 'https:' || (inList(proxies, plain(remote)) && req.headers.get('x-forwarded-proto') === 'https'))) { note('https_required', client, path); return fail('https_required', 'HTTPS only'); }
    const limited = (kind, key) => { const wait = over(`${kind}|${key}`, L[kind]); if (!wait) return null; note('rate_limited:' + kind, client, path); return fail('rate_limited', 'too many requests; wait and try again', { retry_after_seconds: wait }); };
    let stop = limited('perAddress', client); if (stop) return stop;
    if (m === 'GET' && path === '/admin/v1/health') return json({ ok: true, service: 'nexus-admin', api: ADMIN_VERSION, mode, floors });
    if ([...url.searchParams.keys()].length) return fail('bad_request', 'nothing goes in the address after the path; a token or code least of all');
    let body = {};
    if (m === 'POST') {
      const text = await req.text(); if (text.length > 262144) return fail('bad_request', 'the request body is too large');
      try { body = text ? JSON.parse(text) : {}; } catch { return fail('bad_request', 'the body is not valid JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('bad_request', 'the body is a JSON object');
    } else if (m !== 'GET' && m !== 'DELETE') return fail('not_found', 'unknown method');
    const s = (v) => (v == null ? null : String(v)); const token = (req.headers.get('authorization') || '').match(/^Bearer\s+(nxs_[0-9a-f]{64})$/i)?.[1];
    const needSession = () => (token ? null : (note('no_session', client, path), json({ ok: false, error: 'unauthorized', message: 'sign in first, then send Authorization: Bearer <session>' }, 401)));
    try {
      // sign in, confirm, sign out
      if (path === '/admin/v1/session') {
        if (m === 'POST') { stop = limited('signIn', client); if (stop) return stop; return answer(await one('select nexus.session_open($1, $2, $3) r', [s(body.credential), s(body.code), client])); }
        if (m === 'DELETE') return needSession() || answer(await one('select nexus.session_close($1) r', [token]));
        return fail('not_found', 'unknown path');
      }
      if (m === 'POST' && path === '/admin/v1/session/confirm') { stop = needSession() || limited('signIn', client); if (stop) return stop; return answer(await one('select nexus.session_step_up($1, $2, $3) r', [token, s(body.code), client])); }
      const mt = path.match(/^\/admin\/v1\/floors\/([^/]+)(\/.*)?$/);
      if (!mt) return fail('not_found', 'unknown path');
      let floor; try { floor = decodeURIComponent(mt[1]); } catch { floor = ''; } const rest = mt[2] || '';
      if (!FLOOR.test(floor) || !allowed.has(floor)) { note('floor_not_allowed', client, path); return fail('floor_not_allowed', `this administrator service (${mode} mode) does not act on that floor`); }
      // break-glass: no session, no authenticator; a sealed single-use code that can only stop
      if (m === 'POST' && rest === '/break-glass-stop') { stop = limited('breakGlass', client); if (stop) return stop; return answer(await one('select nexus.break_glass_redeem($1, $2, $3, $4) r', [floor, s(body.code), s(body.reason), client])); }
      stop = needSession() || limited(m === 'GET' ? 'read' : 'write', createHash('sha256').update(token || '').digest('hex').slice(0, 16)); if (stop) return stop;
      const call = async (control, args = {}) => answer(await one('select nexus.admin_call($1, $2, $3, $4::text::jsonb, $5, $6) r', [token, control, floor, JSON.stringify(args), client, request]));
      if (m === 'GET' && rest === '/status') return call('floor_status');
      if (m === 'POST' && rest === '/baselines') return call('baseline_submit', { report: body.report ?? null });
      const b = rest.match(/^\/baselines\/([^/]+)(\/[a-z]+)?$/);
      if (b) {
        const id = b[1]; if (!UUID.test(id)) return fail('baseline_not_found', 'no such baseline on this floor');
        if (m === 'GET' && !b[2]) return call('baseline_review', { baseline: id });
        if (m === 'POST' && b[2] === '/approve') return call('baseline_approve', { baseline: id, fingerprint: s(body.fingerprint) });
        if (m === 'POST' && b[2] === '/reject') return call('baseline_reject', { baseline: id, reason: s(body.reason) });
        if (m === 'POST' && b[2] === '/initialize') return call('baseline_initialize', { baseline: id, fingerprint: s(body.fingerprint), backup: s(body.backup) });
        if (m === 'POST' && b[2] === '/revert') return call('baseline_revert', { baseline: id, reason: s(body.reason) });
        return fail('not_found', 'unknown path');
      }
      if (m === 'POST' && rest === '/unlock-approval') return call('floor_unlock_approve');
      if (m === 'POST' && rest === '/unlock') return call('floor_unlock', { confirm: s(body.confirm) });
      if (m === 'POST' && rest === '/stop') return call('floor_stop', { reason: s(body.reason) });
      if (m === 'POST' && rest === '/capacity') return call('location_capacity_verify', { position: s(body.position), capacity: Number.isInteger(body.capacity) ? String(body.capacity) : null, specification: s(body.specification) });
      if (m === 'POST' && rest === '/discrepancies') return call('discrepancy_open', { position: s(body.position), kind: s(body.kind), detail: s(body.detail) });
      const d = m === 'POST' && rest.match(/^\/discrepancies\/(\d{1,12})\/resolve$/);
      if (d) return call('discrepancy_resolve', { discrepancy: d[1], resolution: s(body.resolution) });
      return fail('not_found', 'unknown path');
    } catch (e) { onError(String(e?.message || e).slice(0, 300)); return fail('unavailable', 'The request could not be completed. Check the floor status before trying again.'); }
  };
}
