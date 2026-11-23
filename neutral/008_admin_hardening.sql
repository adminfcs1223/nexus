-- Administrator access, hardened (2026-11-23). Loaded after 006 (and 007 when that is in use). LOCAL ONLY until approved.
--   1. An operator's long-lived credential no longer runs any control. It opens a session (credential + authenticator
--      code); the session lasts minutes, is checked in the database on every call, and can be ended at once.
--   2. Second factor: time-based codes (RFC 6238), verified in the database, each code usable once.
--   3. One entry point for the admin service (admin_call) that records every call, allowed or refused.
--   4. Three service roles, none of them the owner: integration calls, administrator calls, operator management.
--   5. No operator, and no one person across operator records, holds more than one of: company approval, initialize, unlock.
--   6. Audit tables are append-only; a checkpoint digest shows later tampering.
--   7. Break-glass stop: a sealed single-use code per floor that can only stop, never open.
-- The movement engine (nexus.place) is not touched by this file.

create table nexus.admin_settings (name text primary key, value integer not null check (value > 0), note text not null);
insert into nexus.admin_settings values
  ('session_minutes', 15, 'a session ends this long after sign-in, used or not'),
  ('mfa_fresh_minutes', 5, 'approve, initialize and unlock need an authenticator code entered within this many minutes'),
  ('signin_failures', 5, 'wrong codes in a row before an operator is locked out'),
  ('signin_lock_minutes', 15, 'how long that lock lasts'),
  ('credential_days', 90, 'an operator credential older than this no longer opens a session'),
  ('break_glass_days', 90, 'a break-glass code is valid this long');
create function nexus._setting(p_name text) returns integer language sql stable set search_path to 'nexus' as $$ select value from admin_settings where name = p_name $$;

-- pgcrypto lives in a different schema on different hosts; find it once
create extension if not exists pgcrypto;
do $$ declare s text; begin
  select n.nspname into strict s from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgcrypto';
  execute format('create function nexus._hmac_sha1(p_key bytea, p_msg bytea) returns bytea language sql immutable as $f$ select %I.hmac(p_msg, p_key, ''sha1'') $f$', s);
  execute format('create function nexus._random(p_n integer) returns bytea language sql volatile as $f$ select %I.gen_random_bytes(p_n) $f$', s);
end $$;
create function nexus._base32(b bytea) returns text language plpgsql immutable as $$
declare bits text := ''; i integer; o text := ''; alpha constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
begin
  for i in 0 .. length(b) - 1 loop bits := bits || (get_byte(b, i)::bit(8))::text; end loop;
  bits := rpad(bits, ((length(bits) + 4) / 5) * 5, '0');
  for i in 0 .. length(bits) / 5 - 1 loop o := o || substr(alpha, (substr(bits, i * 5 + 1, 5)::bit(5))::integer + 1, 1); end loop;
  return o;
end $$;
-- RFC 6238 / RFC 4226: six digits, 30-second steps, HMAC-SHA1 (what authenticator apps use by default)
create function nexus._totp(p_secret bytea, p_step bigint) returns text language plpgsql immutable as $$
declare h bytea := nexus._hmac_sha1(p_secret, int8send(p_step)); o integer := get_byte(h, 19) & 15;
begin
  return lpad(((((get_byte(h, o) & 127)::bigint << 24) | (get_byte(h, o + 1)::bigint << 16) | (get_byte(h, o + 2)::bigint << 8) | get_byte(h, o + 3)::bigint) % 1000000)::text, 6, '0');
end $$;

-- ───────── operators: one person, separated authority ─────────
alter table nexus.operators add column person text, add column failed_signins integer not null default 0, add column locked_until timestamptz,
  add column credential_set_at timestamptz not null default now(), add column deactivated_at timestamptz, add column deactivated_reason text;
-- at most one of the three authorities that must never sit with one person
create function nexus._authorities(p_roles text[]) returns integer language sql immutable as $$
  select ('approve_baseline' = any (p_roles))::int + ('initialize' = any (p_roles))::int + ('unlock' = any (p_roles))::int $$;
alter table nexus.operators add constraint operators_separated check (nexus._authorities(roles) <= 1);

create table nexus.operator_mfa (
  operator_id uuid primary key references nexus.operators(id), secret bytea not null, enrolled_at timestamptz not null default now(), enrolled_by text not null,
  confirmed_at timestamptz, last_step bigint not null default 0);
create table nexus.operator_sessions (
  id uuid primary key default gen_random_uuid(), operator_id uuid not null references nexus.operators(id), token_hash text not null unique,
  opened_at timestamptz not null default now(), expires_at timestamptz not null, mfa_at timestamptz not null, client text, last_used_at timestamptz,
  closed_at timestamptz, closed_reason text);
create index operator_sessions_open on nexus.operator_sessions (operator_id) where closed_at is null;
create table nexus.break_glass_codes (
  id uuid primary key default gen_random_uuid(), warehouse text not null references nexus.warehouses(code), holder text not null check (length(btrim(holder)) >= 2),
  code_hash text not null unique, issued_at timestamptz not null default now(), issued_by text not null, expires_at timestamptz not null,
  used_at timestamptz, used_client text, used_reason text, revoked_at timestamptz, revoked_by text, reviewed_at timestamptz, reviewed_by text, review_note text);
-- every call the admin service makes, allowed or refused, and every request it turned away before the database was asked
create table nexus.admin_access_log (
  id bigserial primary key, at timestamptz not null default clock_timestamp(), request text, control text not null, warehouse text, client text,
  session_id uuid, operator_id uuid, ok boolean not null, error text, detail jsonb);
create table nexus.audit_checkpoints (id bigserial primary key, at timestamptz not null default now(), by text not null, audit_upto bigint not null, access_upto bigint not null, digest text not null);

-- ───────── audit tables only ever grow ─────────
create function nexus._append_only() returns trigger language plpgsql as $$ begin raise exception '% is append-only: rows are never changed or removed', tg_table_name; end $$;
create trigger audit_log_append_only before update or delete on nexus.audit_log for each row execute function nexus._append_only();
create trigger audit_log_no_truncate before truncate on nexus.audit_log for each statement execute function nexus._append_only();
create trigger admin_access_log_append_only before update or delete on nexus.admin_access_log for each row execute function nexus._append_only();
create trigger admin_access_log_no_truncate before truncate on nexus.admin_access_log for each statement execute function nexus._append_only();
create trigger audit_checkpoints_append_only before update or delete on nexus.audit_checkpoints for each row execute function nexus._append_only();
create trigger audit_checkpoints_no_truncate before truncate on nexus.audit_checkpoints for each statement execute function nexus._append_only();

create function nexus._audit_digest(p_audit_upto bigint, p_access_upto bigint) returns text language sql stable set search_path to 'nexus' as $$
  select _hash(coalesce((select string_agg(_hash(to_jsonb(a)::text), '' order by a.id) from audit_log a where a.id <= p_audit_upto), '') || '|' ||
               coalesce((select string_agg(_hash(to_jsonb(x)::text), '' order by x.id) from admin_access_log x where x.id <= p_access_upto), '')) $$;

-- ───────── sessions ─────────
-- one authenticator code, usable once: the step it belongs to must be later than the last step this operator used
create function nexus._code_ok(p_operator uuid, p_code text) returns boolean language plpgsql set search_path to 'nexus' as $$
declare m operator_mfa; v_now bigint := floor(extract(epoch from clock_timestamp()) / 30)::bigint; s bigint;
begin
  select * into m from operator_mfa where operator_id = p_operator for update;
  if m.operator_id is null or coalesce(p_code, '') !~ '^[0-9]{6}$' then return false; end if;
  for s in v_now - 1 .. v_now + 1 loop
    if s > m.last_step and _totp(m.secret, s) = p_code then
      update operator_mfa set last_step = s, confirmed_at = coalesce(confirmed_at, now()) where operator_id = p_operator; return true;
    end if;
  end loop;
  return false;
end $$;
create function nexus._sessions_close(p_operator uuid, p_reason text) returns integer language sql set search_path to 'nexus' as $$
  with c as (update operator_sessions set closed_at = now(), closed_reason = p_reason where operator_id = p_operator and closed_at is null returning 1) select count(*)::int from c $$;
-- a wrong code: counted, and after the limit the operator is locked and every session ended
create function nexus._code_failed(p_operator uuid) returns void language plpgsql set search_path to 'nexus' as $$
declare n integer;
begin
  update operators set failed_signins = failed_signins + 1 where id = p_operator returning failed_signins into n;
  if n >= _setting('signin_failures') then
    update operators set locked_until = now() + make_interval(mins => _setting('signin_lock_minutes')), failed_signins = 0 where id = p_operator;
    perform _sessions_close(p_operator, 'locked');
    insert into audit_log (actor, action, target, after) values ('op:' || p_operator, 'operator_locked', p_operator::text, jsonb_build_object('minutes', _setting('signin_lock_minutes')));
  end if;
end $$;

-- SIGN IN: credential + authenticator code -> a session token, shown once, valid for minutes
create function nexus.session_open(p_credential text, p_code text, p_client text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare o operators; k text; v_id uuid; v_exp timestamptz; v_why text; v_client text := left(coalesce(p_client, ''), 100);
begin
  select * into o from operators where token_hash = _hash(p_credential) and coalesce(p_credential, '') like 'nxo\_%' for update;
  v_why := case when o.id is null then 'unauthorized' when not o.active then 'operator_inactive' when o.person is null then 'not_enrolled'
    when o.locked_until > now() then 'locked' when o.credential_set_at < now() - make_interval(days => _setting('credential_days')) then 'credential_expired'
    when not exists (select 1 from operator_mfa m where m.operator_id = o.id) then 'mfa_not_enrolled' end;
  if v_why is null and not _code_ok(o.id, p_code) then v_why := 'bad_code'; perform _code_failed(o.id); end if;
  if v_why is not null then
    insert into audit_log (actor, action, target, after) values (case when o.id is null then 'unknown operator' else 'op:' || o.id || ' ' || o.name end, 'signin_refused', o.id::text, jsonb_build_object('reason', v_why, 'client', v_client));
    if v_why = 'locked' then return _no('locked', 'too many wrong codes; sign-in is locked for a while', jsonb_build_object('retry_after_seconds', ceil(extract(epoch from o.locked_until - now()))::int)); end if;
    if v_why in ('credential_expired', 'mfa_not_enrolled', 'not_enrolled') then return _no(v_why, 'this operator cannot sign in until an administrator renews their enrolment'); end if;
    return _no('unauthorized', 'sign-in refused');
  end if;
  perform _sessions_close(o.id, 'replaced by a newer sign-in');
  k := 'nxs_' || encode(_random(32), 'hex'); v_exp := now() + make_interval(mins => _setting('session_minutes'));
  insert into operator_sessions (operator_id, token_hash, expires_at, mfa_at, client) values (o.id, _hash(k), v_exp, now(), nullif(v_client, '')) returning id into v_id;
  update operators set failed_signins = 0, locked_until = null, last_used_at = now() where id = o.id;
  insert into audit_log (actor, action, target, after) values ('op:' || o.id || ' ' || o.name, 'signed_in', o.id::text, jsonb_build_object('session', v_id, 'client', v_client, 'expires_at', v_exp));
  return jsonb_build_object('ok', true, 'session', k, 'expires_at', v_exp, 'fresh_code_until', now() + make_interval(mins => _setting('mfa_fresh_minutes')), 'operator', o.name, 'roles', o.roles, 'floors', o.floors);
end $$;
-- a live session, or why not
create function nexus._session(p_token text, out s nexus.operator_sessions, out why text) language plpgsql set search_path to 'nexus' as $$
begin
  select * into s from operator_sessions x where x.token_hash = _hash(p_token) and coalesce(p_token, '') like 'nxs\_%';
  why := case when s.id is null then 'unauthorized' when s.closed_at is not null then 'session_ended' when s.expires_at <= now() then 'session_expired'
    when not (select active from operators where id = s.operator_id) then 'operator_inactive'
    when coalesce(current_setting('nexus.client', true), '') <> '' and s.client is distinct from current_setting('nexus.client', true) then 'session_wrong_address' end;
end $$;
-- CONFIRM: a fresh code inside a live session, needed shortly before approve, initialize and unlock
create function nexus.session_step_up(p_session text, p_code text, p_client text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare r record; o operators;
begin
  perform set_config('nexus.client', left(coalesce(p_client, ''), 100), true);
  select * into r from _session(p_session);
  if r.why is not null then
    insert into audit_log (actor, action, target, after) values (coalesce('op:' || (r.s).operator_id, 'unknown operator'), 'confirm_refused', (r.s).id::text, jsonb_build_object('reason', r.why, 'client', left(coalesce(p_client, ''), 100)));
    return _no(case when r.why in ('session_ended', 'session_expired') then 'session_expired' else 'unauthorized' end, 'sign in again');
  end if;
  select * into o from operators where id = (r.s).operator_id for update;
  if not _code_ok(o.id, p_code) then
    perform _code_failed(o.id);
    insert into audit_log (actor, action, target, after) values ('op:' || o.id || ' ' || o.name, 'confirm_refused', (r.s).id::text, jsonb_build_object('reason', 'bad_code'));
    return _no('unauthorized', 'that code was not accepted');
  end if;
  update operator_sessions set mfa_at = now(), last_used_at = now() where id = (r.s).id; update operators set failed_signins = 0 where id = o.id;
  insert into audit_log (actor, action, target, after) values ('op:' || o.id || ' ' || o.name, 'confirmed', (r.s).id::text, '{}');
  return jsonb_build_object('ok', true, 'fresh_code_until', now() + make_interval(mins => _setting('mfa_fresh_minutes')), 'expires_at', (r.s).expires_at);
end $$;
create function nexus.session_close(p_session text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare s operator_sessions;
begin
  update operator_sessions x set closed_at = now(), closed_reason = 'signed out' where x.token_hash = _hash(p_session) and x.closed_at is null returning * into s;
  if s.id is not null then insert into audit_log (actor, action, target, after) values ('op:' || s.operator_id, 'signed_out', s.id::text, '{}'); end if;
  return jsonb_build_object('ok', true);   -- the same answer whether or not there was a session to end
end $$;

-- who is using a control. From here on ONLY a live session is accepted; the long-lived credential runs nothing.
-- Approve, initialize and unlock also need a code entered within the last few minutes. Stop never does.
create or replace function nexus._op(p_token text, p_roles text[], out id uuid, out company_id uuid, out name text, out actor text, out error jsonb) language plpgsql set search_path to 'nexus' as $$
declare r record; o operators; v_client text := coalesce(current_setting('nexus.client', true), '');
begin
  select * into r from _session(p_token);
  if r.why is not null then
    if r.why = 'unauthorized' and exists (select 1 from operators x where x.token_hash = _hash(p_token) and coalesce(p_token, '') <> '') then r.why := 'credential_not_a_session'; end if;
    insert into audit_log (actor, action, target, after) values (coalesce('op:' || (r.s).operator_id, 'unknown operator'), 'control_refused', null, jsonb_build_object('reason', r.why, 'needs', p_roles, 'client', v_client));
    error := case when r.why in ('session_ended', 'session_expired') then _no('session_expired', 'the session has ended; sign in again') else _no('unauthorized', 'sign in first') end; return;
  end if;
  select * into o from operators x where x.id = (r.s).operator_id;
  if not (o.roles && p_roles) then
    insert into audit_log (actor, action, target, after) values ('op:' || o.id || ' ' || o.name, 'control_refused', null, jsonb_build_object('reason', 'forbidden', 'needs', p_roles, 'has', o.roles, 'client', v_client));
    error := _no('forbidden', 'this operator may not use this control (needs ' || array_to_string(p_roles, ' or ') || ')'); return;
  end if;
  if p_roles in (array['approve_baseline'], array['initialize'], array['unlock']) and (r.s).mfa_at < now() - make_interval(mins => _setting('mfa_fresh_minutes')) then
    insert into audit_log (actor, action, target, after) values ('op:' || o.id || ' ' || o.name, 'control_refused', null, jsonb_build_object('reason', 'mfa_required', 'needs', p_roles, 'client', v_client));
    error := _no('mfa_required', 'confirm with a fresh authenticator code first', jsonb_build_object('within_minutes', _setting('mfa_fresh_minutes'))); return;
  end if;
  update operator_sessions x set last_used_at = now() where x.id = (r.s).id; update operators x set last_used_at = now() where x.id = o.id;
  id := o.id; company_id := o.company_id; name := o.name; actor := 'op:' || o.id || ' ' || o.name;
end $$;

-- ───────── the admin service's one way in ─────────
-- Every control goes through here. It proves the baseline or discrepancy belongs to the floor in the address, runs the
-- control, and records the outcome whatever it was. A control that fails part-way changes nothing and is recorded too.
create function nexus.admin_call(p_session text, p_control text, p_floor text, p_args jsonb, p_client text, p_request text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a jsonb := coalesce(p_args, '{}'); r jsonb; v_sid uuid; v_oid uuid; v_b uuid; v_d bigint; v_client text := left(coalesce(p_client, ''), 100);
begin
  if v_client = '' then r := _no('unauthorized', 'the caller''s address is required');
  else
    perform set_config('nexus.client', v_client, true);
    begin
      if p_control like 'baseline\_%' and p_control <> 'baseline_submit' then
        if coalesce(a ->> 'baseline', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then r := _no('baseline_not_found', 'no such baseline on this floor');
        else v_b := (a ->> 'baseline')::uuid; r := baseline_review(p_session, p_floor, v_b); end if;   -- who they are, their floor, and that the baseline is on it
      end if;
      if p_control = 'discrepancy_resolve' then
        r := floor_status(p_session, p_floor);
        if (r ->> 'ok')::boolean then
          if coalesce(a ->> 'discrepancy', '') !~ '^[0-9]{1,12}$' or not exists (select 1 from discrepancies d where d.id = (a ->> 'discrepancy')::bigint and d.warehouse = p_floor and d.resolved_at is null)
          then r := _no('not_open', 'no open discrepancy with that number on this floor'); else v_d := (a ->> 'discrepancy')::bigint; end if;
        end if;
      end if;
      if r is null or (r ->> 'ok')::boolean then
        case p_control
          when 'floor_status' then r := floor_status(p_session, p_floor);
          when 'baseline_submit' then r := baseline_submit(p_session, p_floor, a -> 'report');
          when 'baseline_review' then null;
          when 'baseline_approve' then r := baseline_approve(p_session, v_b, a ->> 'fingerprint');
          when 'baseline_reject' then r := baseline_reject(p_session, v_b, a ->> 'reason');
          when 'baseline_initialize' then r := baseline_initialize(p_session, v_b, a ->> 'fingerprint', a ->> 'backup');
          when 'baseline_revert' then r := baseline_revert(p_session, v_b, a ->> 'reason');
          when 'floor_unlock_approve' then r := floor_unlock_approve(p_session, p_floor);
          when 'floor_unlock' then r := floor_unlock(p_session, p_floor, a ->> 'confirm');
          when 'floor_stop' then r := floor_stop(p_session, p_floor, a ->> 'reason');
          when 'location_capacity_verify' then r := location_capacity_verify(p_session, p_floor, a ->> 'position', case when a ->> 'capacity' ~ '^[0-9]{1,6}$' then (a ->> 'capacity')::integer end, a ->> 'specification');
          when 'discrepancy_open' then r := discrepancy_open(p_session, p_floor, a ->> 'position', a ->> 'kind', a ->> 'detail');
          when 'discrepancy_resolve' then r := discrepancy_resolve(p_session, v_d, a ->> 'resolution');
          else r := _no('not_found', 'unknown control');
        end case;
      end if;
    exception when others then
      r := _no('unavailable', 'The control could not be completed and nothing was changed. Check the floor status before trying again.') || jsonb_build_object('_cause', left(sqlerrm, 200));
    end;
  end if;
  select x.id, x.operator_id into v_sid, v_oid from operator_sessions x where x.token_hash = _hash(p_session) and coalesce(p_session, '') <> '';
  insert into admin_access_log (request, control, warehouse, client, session_id, operator_id, ok, error, detail)
  values (left(p_request, 64), left(p_control, 60), left(p_floor, 40), v_client, v_sid, v_oid, coalesce((r ->> 'ok')::boolean, false), r ->> 'error',
    nullif(jsonb_strip_nulls(jsonb_build_object('baseline', v_b, 'discrepancy', v_d, 'position', left(a ->> 'position', 20), 'cause', r ->> '_cause')), '{}'));
  return r - '_cause'::text;
end $$;
-- a request the service turned away before asking the database anything (wrong network, too many requests, no HTTPS…)
create function nexus.admin_edge_refusal(p_reason text, p_client text, p_path text, p_count integer) returns void language sql set search_path to 'nexus' as $$
  insert into admin_access_log (control, client, ok, error, detail) values ('edge', left(coalesce(p_client, ''), 100), false, left(coalesce(p_reason, ''), 40), jsonb_build_object('path', left(coalesce(p_path, ''), 120), 'count', greatest(coalesce(p_count, 1), 1))) $$;

-- ───────── break-glass stop ─────────
-- A sealed code, issued to a named holder for one floor, usable once. It needs no sign-in and no authenticator, and it
-- can do exactly one thing: switch movements off. Reopening afterwards needs a recorded review, a fresh go from each
-- company and the unlock control, like any other stop.
create function nexus.break_glass_redeem(p_warehouse text, p_code text, p_reason text, p_client text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare c break_glass_codes; w warehouses; v_why text; v_client text := left(coalesce(p_client, ''), 100); v_norm text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  select * into c from break_glass_codes where code_hash = _hash(v_norm) and length(v_norm) = 25 for update;
  v_why := case when c.id is null then 'unknown_code' when c.warehouse is distinct from p_warehouse then 'wrong_floor' when c.used_at is not null then 'already_used'
    when c.revoked_at is not null then 'revoked' when c.expires_at <= now() then 'expired' end;
  if v_why is not null then
    insert into audit_log (actor, action, warehouse, target, after) values (coalesce('break-glass:' || c.holder, 'break-glass: unknown'), 'break_glass_refused', (select code from warehouses where code = p_warehouse), c.id::text, jsonb_build_object('reason', v_why, 'client', v_client));
    insert into admin_access_log (control, warehouse, client, ok, error) values ('break_glass_stop', left(p_warehouse, 40), v_client, false, v_why);
    return _no('unauthorized', 'that code is not valid for this floor');
  end if;
  select * into w from warehouses where code = c.warehouse for update;
  perform set_config('nexus.actor', 'break-glass:' || c.holder, true);
  update warehouses set moves_enabled = false, last_stopped_at = now() where code = w.code;
  update unlock_approvals set voided_at = now() where warehouse = w.code and voided_at is null;
  perform set_config('nexus.actor', '', true);
  update break_glass_codes set used_at = now(), used_client = v_client, used_reason = coalesce(nullif(btrim(p_reason), ''), '(none given)') where id = c.id;
  perform _audit('break-glass:' || c.holder, 'movements_stopped', w.code, c.id::text, jsonb_build_object('reason', coalesce(nullif(btrim(p_reason), ''), '(none given)'), 'was_enabled', w.moves_enabled, 'break_glass', true, 'holder', c.holder, 'client', v_client));
  insert into admin_access_log (control, warehouse, client, ok, detail) values ('break_glass_stop', w.code, v_client, true, jsonb_build_object('code', c.id, 'holder', c.holder));
  return jsonb_build_object('ok', true, 'warehouse', w.code, 'moves_enabled', false, 'changed', w.moves_enabled, 'review_required', true);
end $$;

-- CONTROL 3b: unlock, as in 006, plus: a used break-glass code must have been reviewed first
create or replace function nexus.floor_unlock(p_token text, p_warehouse text, p_confirm text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; g jsonb; w warehouses; v_missing jsonb; v_unverified jsonb;
begin
  select * into a from _op(p_token, array['unlock']); if a.error is not null then return a.error; end if;
  g := _floor_gate(a.id, a.actor, p_warehouse); if g is not null then return g; end if;
  select * into w from warehouses where code = p_warehouse for update;
  if w.test then return _no('test_floor', 'a test floor is not opened through these controls'); end if;
  if w.moves_enabled then return jsonb_build_object('ok', true, 'warehouse', w.code, 'moves_enabled', true, 'changed', false); end if;
  if w.occupancy_state <> 'verified' then return _no('not_initialized', 'movements cannot be switched on before occupancy is initialized from an approved baseline'); end if;
  if coalesce(p_confirm, '') <> 'UNLOCK ' || w.code then return _no('confirmation_required', 'confirm by sending exactly: UNLOCK ' || w.code); end if;
  if exists (select 1 from break_glass_codes c where c.warehouse = w.code and c.used_at is not null and c.reviewed_at is null) then return _no('break_glass_review_pending', 'a break-glass stop was used on this floor and has not been reviewed yet'); end if;
  if exists (select 1 from discrepancies where warehouse = w.code and resolved_at is null) then return _no('open_discrepancies', 'unresolved discrepancies must be settled first'); end if;
  select jsonb_agg(code order by code) into v_unverified from locations where warehouse = w.code and kind in ('pallet', 'staging') and not capacity_verified;
  if v_unverified is not null then return _no('capacity_not_verified', 'every position''s capacity must be verified against the physical specification first', jsonb_build_object('positions', jsonb_array_length(v_unverified))); end if;
  select jsonb_agg(c.code order by c.code) into v_missing from _required_companies() c where not exists (select 1 from unlock_approvals u where u.warehouse = w.code and u.company_id = c.id and u.voided_at is null);
  if v_missing is not null then return _no('unlock_not_approved', 'each company must give its go after the floor was initialized or last stopped', jsonb_build_object('still_needed_from', v_missing)); end if;
  perform set_config('nexus.unlock_ok', w.code, true);
  update warehouses set moves_enabled = true, last_unlocked_at = now() where code = w.code;
  perform set_config('nexus.unlock_ok', '', true);
  insert into change_log (warehouse, kind) values (w.code, 'movements_enabled');
  perform _audit(a.actor, 'movements_enabled', w.code, null, jsonb_build_object('approved_by', (select jsonb_agg(jsonb_build_object('company', c.code, 'by', o.name, 'at', u.at) order by c.code, o.name) from unlock_approvals u join companies c on c.id = u.company_id join operators o on o.id = u.operator_id where u.warehouse = w.code and u.voided_at is null)));
  return jsonb_build_object('ok', true, 'warehouse', w.code, 'moves_enabled', true, 'changed', true);
end $$;

-- ───────── operator management (role nexus_security_admin; never the admin service, never an operator) ─────────
-- The person running these is identified by their own database login, which they cannot choose.
create function nexus._who() returns text language sql stable as $$ select 'db:' || session_user $$;
drop function if exists nexus.operator_create(text, text, text, text[], text[], boolean);
-- Enrol a person. Returns the credential and the authenticator secret ONCE; only a hash of the credential is kept.
create function nexus.operator_enroll(p_person text, p_company text, p_name text, p_roles text[], p_floors text[], p_synthetic boolean) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare k text := 'nxo_' || encode(_random(32), 'hex'); v_secret bytea := _random(20); v_co uuid; v_id uuid; f text; v_person text := lower(btrim(coalesce(p_person, ''))); v_all text[]; v_syn boolean := coalesce(p_synthetic, false);
begin
  if v_person !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'an operator is a named person: give their email address'; end if;
  if p_company is not null then select id into strict v_co from companies where code = p_company; end if;
  if p_floors is null or cardinality(p_floors) = 0 then raise exception 'an operator is assigned to at least one floor'; end if;
  foreach f in array p_floors loop
    if not exists (select 1 from warehouses w where w.code = f and w.rehearsal = v_syn) then raise exception 'floor % does not exist or is not a % floor', f, case when v_syn then 'rehearsal' else 'real' end; end if;
  end loop;
  -- the same person under a second record must not gather what one record may not hold, nor sit in two companies
  select array_agg(distinct x) into v_all from (select unnest(roles) x from operators where person = v_person and active union select unnest(p_roles)) u;
  if _authorities(v_all) > 1 then raise exception 'one person cannot hold more than one of: company approval, initialize, unlock'; end if;
  if exists (select 1 from operators where person = v_person and active and (company_id is distinct from v_co or synthetic <> v_syn)) then raise exception 'that person is already enrolled for a different company or kind of floor'; end if;
  insert into operators (person, company_id, name, roles, token_hash, floors, synthetic) values (v_person, v_co, btrim(p_name), p_roles, _hash(k), p_floors, v_syn) returning id into v_id;
  insert into operator_mfa (operator_id, secret, enrolled_by) values (v_id, v_secret, _who());
  perform _audit(_who(), 'operator_enrolled', null, v_id::text, jsonb_build_object('person', v_person, 'name', btrim(p_name), 'company', p_company, 'roles', p_roles, 'floors', p_floors, 'synthetic', v_syn));
  return jsonb_build_object('ok', true, 'operator', v_id, 'credential', k, 'authenticator_secret', _base32(v_secret),
    'authenticator_uri', 'otpauth://totp/Nexus:' || v_person || '?secret=' || _base32(v_secret) || '&issuer=Nexus&algorithm=SHA1&digits=6&period=30');
end $$;
create function nexus.operator_credential_rotate(p_operator uuid) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare k text := 'nxo_' || encode(_random(32), 'hex'); n integer;
begin
  update operators set token_hash = _hash(k), credential_set_at = now(), failed_signins = 0, locked_until = null where id = p_operator and active; if not found then return _no('operator_not_found', 'no such active operator'); end if;
  n := _sessions_close(p_operator, 'credential replaced'); perform _audit(_who(), 'operator_credential_replaced', null, p_operator::text, jsonb_build_object('sessions_ended', n));
  return jsonb_build_object('ok', true, 'operator', p_operator, 'credential', k, 'sessions_ended', n);
end $$;
create function nexus.operator_mfa_reset(p_operator uuid) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare v_secret bytea := _random(20); n integer; o operators;
begin
  select * into o from operators where id = p_operator and active; if o.id is null then return _no('operator_not_found', 'no such active operator'); end if;
  insert into operator_mfa (operator_id, secret, enrolled_by) values (o.id, v_secret, _who()) on conflict (operator_id) do update set secret = excluded.secret, enrolled_at = now(), enrolled_by = excluded.enrolled_by, confirmed_at = null, last_step = 0;
  n := _sessions_close(o.id, 'authenticator replaced'); perform _audit(_who(), 'operator_authenticator_replaced', null, o.id::text, jsonb_build_object('sessions_ended', n));
  return jsonb_build_object('ok', true, 'operator', o.id, 'authenticator_secret', _base32(v_secret), 'sessions_ended', n);
end $$;
create function nexus.sessions_revoke(p_operator uuid, p_reason text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare n integer;
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 then return _no('bad_request', 'a reason is required'); end if;
  n := _sessions_close(p_operator, 'revoked: ' || btrim(p_reason)); perform _audit(_who(), 'sessions_revoked', null, p_operator::text, jsonb_build_object('reason', btrim(p_reason), 'sessions_ended', n));
  return jsonb_build_object('ok', true, 'sessions_ended', n);
end $$;
create function nexus.operator_deactivate(p_operator uuid, p_reason text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare n integer;
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 then return _no('bad_request', 'a reason is required'); end if;
  update operators set active = false, deactivated_at = now(), deactivated_reason = btrim(p_reason) where id = p_operator and active; if not found then return _no('operator_not_found', 'no such active operator'); end if;
  n := _sessions_close(p_operator, 'operator deactivated'); perform _audit(_who(), 'operator_deactivated', null, p_operator::text, jsonb_build_object('reason', btrim(p_reason), 'sessions_ended', n));
  return jsonb_build_object('ok', true, 'sessions_ended', n);
end $$;
-- Issue a break-glass code for one floor to a named holder. Shown once, as five groups of five characters.
create function nexus.break_glass_issue(p_warehouse text, p_holder text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare v_code text := left(_base32(_random(16)), 25); v_id uuid; v_exp timestamptz := now() + make_interval(days => _setting('break_glass_days'));
begin
  if not exists (select 1 from warehouses where code = p_warehouse) then return _no('warehouse_not_found', 'no such floor'); end if;
  insert into break_glass_codes (warehouse, holder, code_hash, issued_by, expires_at) values (p_warehouse, btrim(p_holder), _hash(v_code), _who(), v_exp) returning id into v_id;
  perform _audit(_who(), 'break_glass_issued', p_warehouse, v_id::text, jsonb_build_object('holder', btrim(p_holder), 'expires_at', v_exp));
  return jsonb_build_object('ok', true, 'id', v_id, 'warehouse', p_warehouse, 'holder', btrim(p_holder), 'expires_at', v_exp,
    'code', substr(v_code, 1, 5) || '-' || substr(v_code, 6, 5) || '-' || substr(v_code, 11, 5) || '-' || substr(v_code, 16, 5) || '-' || substr(v_code, 21, 5));
end $$;
create function nexus.break_glass_revoke(p_id uuid, p_reason text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare c break_glass_codes;
begin
  update break_glass_codes set revoked_at = now(), revoked_by = _who() where id = p_id and used_at is null and revoked_at is null returning * into c;
  if c.id is null then return _no('not_found', 'no unused code with that id'); end if;
  perform _audit(_who(), 'break_glass_revoked', c.warehouse, c.id::text, jsonb_build_object('reason', coalesce(nullif(btrim(p_reason), ''), '(none given)'), 'holder', c.holder));
  return jsonb_build_object('ok', true);
end $$;
create function nexus.break_glass_review(p_id uuid, p_note text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare c break_glass_codes;
begin
  if length(btrim(coalesce(p_note, ''))) < 10 then return _no('bad_request', 'record what happened and what was checked'); end if;
  update break_glass_codes set reviewed_at = now(), reviewed_by = _who(), review_note = btrim(p_note) where id = p_id and used_at is not null and reviewed_at is null returning * into c;
  if c.id is null then return _no('not_found', 'no used, unreviewed code with that id'); end if;
  perform _audit(_who(), 'break_glass_reviewed', c.warehouse, c.id::text, jsonb_build_object('note', btrim(p_note), 'holder', c.holder));
  return jsonb_build_object('ok', true);
end $$;
-- Fix the audit trail's state in a digest. Keep the returned digest somewhere outside this database.
create function nexus.audit_checkpoint() returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a bigint := coalesce((select max(id) from audit_log), 0); x bigint := coalesce((select max(id) from admin_access_log), 0); d text; v_id bigint;
begin
  d := _audit_digest(a, x); insert into audit_checkpoints (by, audit_upto, access_upto, digest) values (_who(), a, x, d) returning id into v_id;
  return jsonb_build_object('ok', true, 'checkpoint', v_id, 'audit_upto', a, 'access_upto', x, 'digest', d);
end $$;
create function nexus.audit_verify() returns jsonb language sql stable set search_path to 'nexus' as $$
  select jsonb_build_object('ok', coalesce(bool_and(c.digest = _audit_digest(c.audit_upto, c.access_upto)), true), 'checkpoints', count(*),
    'broken', coalesce(jsonb_agg(c.id order by c.id) filter (where c.digest <> _audit_digest(c.audit_upto, c.access_upto)), '[]')) from audit_checkpoints c $$;
-- who exists and what is live, with no secret in it
create function nexus.security_overview() returns jsonb language sql stable set search_path to 'nexus' as $$
  select jsonb_build_object('ok', true,
    'operators', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'person', o.person, 'name', o.name, 'company', (select code from companies where id = o.company_id), 'roles', o.roles, 'floors', o.floors, 'synthetic', o.synthetic, 'active', o.active,
        'locked', coalesce(o.locked_until > now(), false), 'credential_age_days', floor(extract(epoch from now() - o.credential_set_at) / 86400)::int, 'authenticator_confirmed', (select m.confirmed_at is not null from operator_mfa m where m.operator_id = o.id), 'last_used_at', o.last_used_at) order by o.name), '[]') from operators o),
    'live_sessions', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'operator', s.operator_id, 'opened_at', s.opened_at, 'expires_at', s.expires_at, 'client', s.client) order by s.opened_at), '[]') from operator_sessions s where s.closed_at is null and s.expires_at > now()),
    'break_glass', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'warehouse', c.warehouse, 'holder', c.holder, 'expires_at', c.expires_at, 'state', case when c.revoked_at is not null then 'revoked' when c.used_at is not null and c.reviewed_at is null then 'used, review pending' when c.used_at is not null then 'used' when c.expires_at <= now() then 'expired' else 'sealed' end) order by c.issued_at), '[]') from break_glass_codes c)) $$;

-- ───────── who may run what ─────────
do $$ begin if not exists (select 1 from pg_roles where rolname = 'nexus_security_admin') then create role nexus_security_admin nologin; end if; end $$;
create or replace function nexus._service_functions(out fn text, out service text) returns setof record language sql immutable as $$
  select f, 'nexus_api' from unnest(array['api_place', 'api_occupancy', 'api_changes', 'api_moves', 'api_map', 'api_calendar', 'api_calendar_put']) f
  union all select f, 'nexus_admin_api' from unnest(array['session_open', 'session_step_up', 'session_close', 'admin_call', 'admin_edge_refusal', 'break_glass_redeem']) f
  union all select f, 'nexus_security_admin' from unnest(array['operator_enroll', 'operator_credential_rotate', 'operator_mfa_reset', 'operator_deactivate', 'sessions_revoke',
    'break_glass_issue', 'break_glass_revoke', 'break_glass_review', 'audit_checkpoint', 'audit_verify', 'security_overview', 'permission_audit']) f $$;
create or replace function nexus.permission_audit() returns jsonb language sql stable set search_path to 'nexus' as $$
  with roles as (select r.oid, r.rolname from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'nexus_api', 'nexus_admin_api', 'nexus_security_admin')),
  own as (select c.relowner oid from pg_class c where c.oid = 'nexus.warehouses'::regclass),
  f as (select p.oid, p.proname, p.oid::regprocedure::text sig, p.prosecdef, p.proconfig, p.proacl, p.proowner, (select service from nexus._service_functions() s where s.fn = p.proname) service from pg_proc p where p.pronamespace = 'nexus'::regnamespace),
  g as (select f.*, a.grantee, case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end who from f left join lateral aclexplode(f.proacl) a on a.privilege_type = 'EXECUTE'),
  problems as (
    select 'function_default_acl' code, sig what, 'no explicit permissions: PostgreSQL lets everyone run it' detail from f where proacl is null
    union all select 'function_public', sig, 'PUBLIC may run it' from g where who = 'PUBLIC'
    union all select 'function_wrong_role', sig, who || ' may run it' from g where who is not null and who <> 'PUBLIC' and grantee <> (select oid from own) and who is distinct from service
    union all select 'function_wrong_owner', sig, 'not owned by the schema''s owner' from f where proowner <> (select oid from own)
    union all select 'service_function_not_granted', sig, service || ' cannot run its own call' from f where service is not null and not has_function_privilege(service, f.oid, 'execute')
    union all select 'service_function_not_definer', sig, 'runs with the caller''s rights' from f where service is not null and not prosecdef
    union all select 'service_function_search_path', sig, 'search path is not pinned' from f where service is not null and not coalesce(proconfig @> array['search_path=nexus, pg_temp'], false)
    union all select 'internal_function_definer', sig, 'an internal function must not run with the owner''s rights' from f where service is null and prosecdef
    union all select 'role_can_run', f.sig, r.rolname || ' may run it' from f cross join roles r where r.rolname is distinct from f.service and has_function_privilege(r.oid, f.oid, 'execute')
    union all select 'table_readable', c.oid::regclass::text, r.rolname || ' has ' || p.priv from pg_class c cross join roles r cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate')) p(priv)
      where c.relnamespace = 'nexus'::regnamespace and c.relkind in ('r', 'v') and has_table_privilege(r.oid, c.oid, p.priv)
    union all select 'table_public', c.oid::regclass::text, 'PUBLIC has a table privilege' from pg_class c, lateral aclexplode(c.relacl) a where c.relnamespace = 'nexus'::regnamespace and c.relkind in ('r', 'v', 'S') and a.grantee = 0
    union all select 'schema_usage', 'schema nexus', r.rolname || ' may use the schema' from roles r where r.rolname in ('anon', 'authenticated', 'service_role') and has_schema_privilege(r.oid, 'nexus', 'usage')
    union all select 'schema_create', 'schema nexus', r.rolname || ' may create objects in the schema' from roles r where has_schema_privilege(r.oid, 'nexus', 'create')
    union all select 'schema_public', 'schema nexus', 'PUBLIC may use the schema' from pg_namespace n, lateral aclexplode(n.nspacl) a where n.nspname = 'nexus' and a.grantee = 0
    union all select 'service_role_powerful', r.rolname, 'a service role must not be a superuser, create roles or databases, bypass row security, or be a member of the owner' from pg_roles r
      where r.rolname in ('nexus_api', 'nexus_admin_api', 'nexus_security_admin') and (r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolbypassrls or pg_has_role(r.oid, (select oid from own), 'member'))
    union all select 'service_role_login', r.rolname, 'a service role is a group; people and services log in as their own role and are granted it' from pg_roles r where r.rolname in ('nexus_api', 'nexus_admin_api', 'nexus_security_admin') and r.rolcanlogin
    union all select 'audit_not_append_only', t, 'the append-only guard is missing' from unnest(array['audit_log', 'admin_access_log', 'audit_checkpoints']) t
      where (select count(*) from pg_trigger g where g.tgrelid = ('nexus.' || t)::regclass and not g.tgisinternal and g.tgenabled <> 'D' and g.tgfoid = 'nexus._append_only'::regproc) < 2
    union all select 'rls_off', c.oid::regclass::text, 'row security is off' from pg_class c where c.relnamespace = 'nexus'::regnamespace and c.relkind = 'r' and not c.relrowsecurity)
  select jsonb_build_object('ok', not exists (select 1 from problems), 'functions', (select count(*) from f), 'service_functions', (select count(*) from f where service is not null),
    'owner', (select r.rolname from pg_roles r, own where r.oid = own.oid), 'owner_can_log_in', (select r.rolcanlogin or r.rolsuper from pg_roles r, own where r.oid = own.oid),
    'problems', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'what', what, 'detail', detail) order by code, what, detail), '[]') from problems)) $$;
do $$ declare r record; begin
  revoke all on schema nexus from public; revoke all on all tables in schema nexus from public; revoke all on all sequences in schema nexus from public; revoke all on all functions in schema nexus from public;
  for r in select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role', 'nexus_api', 'nexus_admin_api', 'nexus_security_admin') loop
    execute format('revoke all on schema nexus from %I', r.rolname); execute format('revoke all on all tables in schema nexus from %I', r.rolname);
    execute format('revoke all on all sequences in schema nexus from %I', r.rolname); execute format('revoke all on all functions in schema nexus from %I', r.rolname);
  end loop;
  for r in select c.oid::regclass t from pg_class c where c.relnamespace = 'nexus'::regnamespace and c.relkind = 'r' loop execute format('alter table %s enable row level security', r.t); end loop;
  grant usage on schema nexus to nexus_api, nexus_admin_api, nexus_security_admin;
  -- a service function runs with the owner's rights on a pinned search path; everything else, the thirteen controls
  -- included, is internal again: reachable only from inside admin_call, never directly by any service role
  for r in select p.oid::regprocedure sig, s.service from pg_proc p left join nexus._service_functions() s on s.fn = p.proname where p.pronamespace = 'nexus'::regnamespace loop
    if r.service is null then execute format('alter function %s security invoker', r.sig);
    else execute format('alter function %s security definer set search_path = nexus, pg_temp', r.sig); execute format('grant execute on function %s to %I', r.sig, r.service); end if;
  end loop;
end $$;
