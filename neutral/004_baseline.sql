-- Baseline controls for a real floor (2026-11-23). Five separate controls, each its own function, role and audit entry:
--   approve the physical baseline · initialize occupancy · unlock movements · stop movements · view history and discrepancies.
-- A baseline is accepted only as the dry-run validator's report: Nexus recomputes the fingerprint and re-checks every rule
-- itself, so a report that was edited after validation is refused. Nothing here reads earlier location records, and ids
-- that exist on a test floor are refused. The movement engine (nexus.place) is not touched by this file.
alter table nexus.warehouses add column if not exists last_unlocked_at timestamptz, add column if not exists last_stopped_at timestamptz;
alter table nexus.locations add column if not exists capacity_verified boolean not null default false, add column if not exists capacity_spec text;
alter table nexus.audit_log add column if not exists warehouse text;

-- a person allowed to use a control. The token is shown once; only its hash is kept. An approver always belongs to a company.
create table nexus.operators (
  id uuid primary key default gen_random_uuid(), company_id uuid references nexus.companies(id), name text not null check (length(btrim(name)) >= 2),
  roles text[] not null check (roles <@ array['approve_baseline', 'initialize', 'unlock', 'stop', 'registry', 'view'] and cardinality(roles) > 0),
  token_hash text not null unique, active boolean not null default true, created_at timestamptz not null default now(), last_used_at timestamptz,
  check (not ('approve_baseline' = any (roles)) or company_id is not null));

create table nexus.baselines (
  id uuid primary key default gen_random_uuid(), warehouse text not null references nexus.warehouses(code), fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  map_version integer not null, map_checksum text not null, content jsonb not null, counters jsonb not null, positions integer not null, pallets integer not null,
  status text not null default 'submitted' check (status in ('submitted', 'approved', 'applied', 'superseded', 'rejected', 'reverted')), status_reason text,
  submitted_by uuid not null references nexus.operators(id), submitted_at timestamptz not null default now(),
  applied_by uuid references nexus.operators(id), applied_at timestamptz, backup_ref text);
create unique index baselines_one_open on nexus.baselines (warehouse) where status in ('submitted', 'approved', 'applied');
create table nexus.baseline_approvals (
  baseline_id uuid not null references nexus.baselines(id), company_id uuid not null references nexus.companies(id), operator_id uuid not null references nexus.operators(id),
  fingerprint text not null, at timestamptz not null default now(), primary key (baseline_id, company_id));
create table nexus.unlock_approvals (
  id bigserial primary key, warehouse text not null references nexus.warehouses(code), company_id uuid not null references nexus.companies(id), operator_id uuid not null references nexus.operators(id), at timestamptz not null default now(), voided_at timestamptz);
create table nexus.discrepancies (
  id bigserial primary key, warehouse text not null references nexus.warehouses(code), position_code text, kind text not null, detail text not null check (length(btrim(detail)) >= 3),
  opened_by uuid not null references nexus.operators(id), opened_at timestamptz not null default now(), resolved_by uuid references nexus.operators(id), resolved_at timestamptz, resolution text);
alter table nexus.operators enable row level security; alter table nexus.baselines enable row level security; alter table nexus.baseline_approvals enable row level security;
alter table nexus.unlock_approvals enable row level security; alter table nexus.discrepancies enable row level security;

create function nexus._no(p_error text, p_message text, p_more jsonb default '{}') returns jsonb language sql immutable as $$ select jsonb_build_object('ok', false, 'error', p_error, 'message', p_message) || p_more $$;
create function nexus._audit(p_actor text, p_action text, p_warehouse text, p_target text, p_after jsonb) returns void language sql set search_path to 'nexus' as $$
  insert into audit_log (actor, action, warehouse, target, after) values (p_actor, p_action, p_warehouse, p_target, p_after) $$;
-- the same value api_map publishes as `checksum`
create function nexus._map_checksum(p_warehouse text) returns text language sql stable set search_path to 'nexus' as $$
  select _hash((select coalesce(jsonb_agg(jsonb_build_object('code', l.code, 'kind', l.kind, 'zone', l.zone, 'block', l.map_block, 'col', l.map_col, 'row', l.map_row, 'x', l.map_x, 'y', l.map_y, 'capacity', l.capacity, 'status', l.status) order by l.map_block, l.map_col, l.map_row, l.code), '[]')
    from locations l where l.warehouse = w.code and l.map_block is not null)::text || w.landmarks::text || w.layout::text) from warehouses w where w.code = p_warehouse $$;
-- companies whose approval a floor needs: every active company
create function nexus._required_companies() returns setof nexus.companies language sql stable set search_path to 'nexus' as $$ select * from companies where active $$;

create function nexus.operator_create(p_actor text, p_company text, p_name text, p_roles text[]) returns text language plpgsql set search_path to 'nexus' as $$
declare k text := 'nxo_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''); v_co uuid; v_id uuid;
begin
  if p_company is not null then select id into strict v_co from companies where code = p_company; end if;
  insert into operators (company_id, name, roles, token_hash) values (v_co, btrim(p_name), p_roles, _hash(k)) returning id into v_id;
  perform _audit(p_actor, 'operator_created', null, v_id::text, jsonb_build_object('name', btrim(p_name), 'company', p_company, 'roles', p_roles));
  return k;
end $$;
-- who is using a control; needs any one of p_roles
create function nexus._op(p_token text, p_roles text[], out id uuid, out company_id uuid, out name text, out actor text, out error jsonb) language plpgsql set search_path to 'nexus' as $$
declare o operators;
begin
  select * into o from operators where token_hash = _hash(p_token) and coalesce(p_token, '') <> '';
  if o.id is null or not o.active then error := _no('unauthorized', 'unknown or inactive operator'); return; end if;
  if not (o.roles && p_roles) then error := _no('forbidden', 'this operator may not use this control (needs ' || array_to_string(p_roles, ' or ') || ')'); return; end if;
  update operators set last_used_at = now() where operators.id = o.id;
  id := o.id; company_id := o.company_id; name := o.name; actor := 'op:' || o.id || ' ' || o.name;
end $$;

-- the fingerprint, computed the way the validator computes it: one line per pallet, or one per empty position
create function nexus._baseline_fingerprint(p_map_version integer, p_map_checksum text, p_content jsonb) returns text language sql immutable set search_path to 'nexus' as $$
  select _hash('nexus-baseline v2' || chr(10) || 'map v' || p_map_version || ' ' || p_map_checksum || chr(10) || coalesce((
    select string_agg(x.line, chr(10) order by x.pos collate "C", x.company collate "C", x.pallet collate "C") from (
      select e ->> 'position' pos, coalesce(p ->> 'company', '') company, coalesce(p ->> 'pallet', '') pallet,
        (e ->> 'position') || chr(9) || coalesce(p ->> 'company', '') || chr(9) || coalesce(p ->> 'pallet', '') line
      from jsonb_array_elements(p_content) e left join lateral jsonb_array_elements(case when jsonb_array_length(coalesce(e -> 'pallets', '[]')) > 0 then e -> 'pallets' else '[null]'::jsonb end) p on true) x), '')) $$;
-- every rule a baseline must meet, checked by Nexus itself. Returns the list of problems (empty = sound).
create function nexus._baseline_problems(p_warehouse text, p_content jsonb) returns jsonb language plpgsql stable set search_path to 'nexus' as $$
declare v jsonb := '[]'; r record;
begin
  if jsonb_typeof(p_content) <> 'array' then return jsonb_build_array(jsonb_build_object('code', 'bad_report', 'message', 'the baseline is not a list of positions')); end if;
  for r in select l.code from locations l where l.warehouse = p_warehouse and l.kind in ('pallet', 'staging') and not exists (select 1 from jsonb_array_elements(p_content) e where e ->> 'position' = l.code) order by l.code loop
    v := v || jsonb_build_object('code', 'missing_position', 'position', r.code, 'message', r.code || ' is not in the baseline'); end loop;
  for r in select e ->> 'position' pos, count(*) n from jsonb_array_elements(p_content) e group by 1 loop
    if not exists (select 1 from locations l where l.warehouse = p_warehouse and l.code = r.pos and l.kind in ('pallet', 'staging')) then v := v || jsonb_build_object('code', 'unknown_position', 'position', r.pos, 'message', coalesce(r.pos, '(blank)') || ' is not a position on this floor');
    elsif r.n > 1 then v := v || jsonb_build_object('code', 'conflicting_rows', 'position', r.pos, 'message', r.pos || ' appears more than once'); end if;
  end loop;
  for r in select e ->> 'position' pos, p ->> 'company' company, p ->> 'pallet' pallet from jsonb_array_elements(p_content) e, jsonb_array_elements(coalesce(e -> 'pallets', '[]')) p loop
    if not exists (select 1 from companies c where c.code = r.company and c.active) then v := v || jsonb_build_object('code', 'unknown_owner', 'position', r.pos, 'message', coalesce(r.company, '(blank)') || ' at ' || r.pos || ' is not a company on this floor'); end if;
    if r.pallet is null or length(btrim(r.pallet)) not between 1 and 64 or r.pallet <> btrim(r.pallet) or r.pallet ~ '[[:cntrl:]]' then v := v || jsonb_build_object('code', 'bad_pallet_id', 'position', r.pos, 'message', 'the pallet id at ' || r.pos || ' is missing, too long or not clean text');
    elsif exists (select 1 from pallets x join warehouses tw on tw.code = x.warehouse and tw.test join companies c on c.id = x.company_id where c.code = r.company and upper(x.external_id) = upper(r.pallet)) then
      v := v || jsonb_build_object('code', 'test_pallet_id', 'position', r.pos, 'message', r.pallet || ' is a test-floor pallet id; test occupancy is never part of a real baseline'); end if;
  end loop;
  for r in select p ->> 'company' company, upper(p ->> 'pallet') pallet, string_agg(e ->> 'position', ' and ' order by e ->> 'position') spots from jsonb_array_elements(p_content) e, jsonb_array_elements(coalesce(e -> 'pallets', '[]')) p group by 1, 2 having count(*) > 1 loop
    v := v || jsonb_build_object('code', 'duplicate_pallet', 'message', r.company || ' pallet ' || r.pallet || ' is listed at ' || r.spots); end loop;
  -- capacity: the approved specification. A position whose capacity has not been verified holds one pallet, staging included.
  for r in select l.code, jsonb_array_length(coalesce(e -> 'pallets', '[]')) n, case when l.capacity_verified then l.capacity else 1 end cap, l.capacity_verified, l.status
    from jsonb_array_elements(p_content) e join locations l on l.warehouse = p_warehouse and l.code = e ->> 'position' loop
    if r.n > 0 and r.status <> 'open' then v := v || jsonb_build_object('code', 'position_not_open', 'position', r.code, 'message', r.code || ' is ' || r.status || ' and cannot hold a pallet'); end if;
    if r.cap is not null and r.n > r.cap then v := v || jsonb_build_object('code', 'over_capacity', 'position', r.code, 'message', r.code || ' holds ' || r.cap || case when r.capacity_verified then '' else ' (capacity not verified, so one)' end || '; the baseline lists ' || r.n); end if;
  end loop;
  return v;
end $$;

-- CONTROL 0 (feeds control 1): hand Nexus the validator's report. Stored only if Nexus's own checks agree with it.
create function nexus.baseline_submit(p_token text, p_warehouse text, p_report jsonb) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; w warehouses; v_content jsonb := p_report -> 'baseline'; v_fp text; v_problems jsonb; v_id uuid; c1 jsonb := p_report #> '{counters,count_1}'; c2 jsonb := p_report #> '{counters,count_2}';
begin
  select * into a from _op(p_token, array['initialize', 'approve_baseline']); if a.error is not null then return a.error; end if;
  select * into w from warehouses where code = p_warehouse for update;
  if w.code is null then return _no('warehouse_not_found', 'no such floor'); end if;
  if w.test then return _no('test_floor', 'a test floor holds synthetic pallets only and takes no baseline'); end if;
  if w.occupancy_state <> 'not_initialized' then return _no('already_initialized', 'this floor already has a verified baseline'); end if;
  if coalesce((p_report ->> 'format_version')::int, 0) <> 2 or p_report ->> 'dry_run' is distinct from 'true' or p_report ->> 'ready_for_joint_approval' is distinct from 'true' or v_content is null then
    return _no('not_a_passed_report', 'only a validator report that passed (zero errors, zero discrepancies) is accepted'); end if;
  if (p_report ->> 'map_version')::int is distinct from w.map_version or p_report ->> 'map_checksum' is distinct from _map_checksum(w.code) then
    return _no('map_mismatch', 'the count was validated against a different map than this floor has now', jsonb_build_object('floor_map_version', w.map_version)); end if;
  if jsonb_typeof(c1) <> 'array' or jsonb_typeof(c2) <> 'array' or jsonb_array_length(c1) = 0 or jsonb_array_length(c2) = 0
     or exists (select 1 from jsonb_array_elements_text(c1) x join jsonb_array_elements_text(c2) y on lower(btrim(x)) = lower(btrim(y))) then
    return _no('counts_not_independent', 'a baseline needs two counts made by different people'); end if;
  v_fp := _baseline_fingerprint(w.map_version, _map_checksum(w.code), v_content);
  if v_fp is distinct from p_report ->> 'baseline_fingerprint' then return _no('fingerprint_mismatch', 'the report''s fingerprint does not match its contents; it was changed after validation'); end if;
  v_problems := _baseline_problems(w.code, v_content);
  if jsonb_array_length(v_problems) > 0 then return _no('baseline_invalid', 'Nexus''s own checks found problems; nothing was stored', jsonb_build_object('problems', v_problems)); end if;
  update baselines set status = 'superseded', status_reason = 'replaced by a newer submission' where warehouse = w.code and status in ('submitted', 'approved');
  insert into baselines (warehouse, fingerprint, map_version, map_checksum, content, counters, positions, pallets, submitted_by)
  values (w.code, v_fp, w.map_version, _map_checksum(w.code), v_content, p_report -> 'counters', jsonb_array_length(v_content), (select count(*) from jsonb_array_elements(v_content) e, jsonb_array_elements(coalesce(e -> 'pallets', '[]')) p), a.id) returning id into v_id;
  perform _audit(a.actor, 'baseline_submitted', w.code, v_id::text, jsonb_build_object('fingerprint', v_fp));
  return jsonb_build_object('ok', true, 'baseline', v_id, 'fingerprint', v_fp, 'status', 'submitted', 'needs_approval_from', (select jsonb_agg(code order by code) from _required_companies()));
end $$;

-- CONTROL 1: approve the physical baseline. One approval per company, each quoting the fingerprint.
create function nexus.baseline_approve(p_token text, p_baseline uuid, p_fingerprint text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; b baselines; v_missing jsonb;
begin
  select * into a from _op(p_token, array['approve_baseline']); if a.error is not null then return a.error; end if;
  select * into b from baselines where id = p_baseline for update;
  if b.id is null then return _no('baseline_not_found', 'no such baseline'); end if;
  if b.status not in ('submitted', 'approved') then return _no('baseline_closed', 'this baseline is ' || b.status || ' and can no longer be approved'); end if;
  if lower(btrim(coalesce(p_fingerprint, ''))) <> b.fingerprint then return _no('fingerprint_mismatch', 'that is not this baseline''s fingerprint; nothing was approved'); end if;
  if a.id = b.submitted_by then return _no('not_independent', 'the person who submitted a baseline cannot also approve it'); end if;
  if not exists (select 1 from _required_companies() c where c.id = a.company_id) then return _no('forbidden', 'this operator''s company does not approve baselines for this floor'); end if;
  if exists (select 1 from baseline_approvals x where x.baseline_id = b.id and x.operator_id = a.id) then null;
  elsif exists (select 1 from baseline_approvals x where x.baseline_id = b.id and x.company_id = a.company_id) then return _no('already_approved', 'this company has already approved');
  else
    insert into baseline_approvals (baseline_id, company_id, operator_id, fingerprint) values (b.id, a.company_id, a.id, b.fingerprint);
    perform _audit(a.actor, 'baseline_approved', b.warehouse, b.id::text, jsonb_build_object('fingerprint', b.fingerprint, 'company', (select code from companies where id = a.company_id)));
  end if;
  select jsonb_agg(c.code order by c.code) into v_missing from _required_companies() c where not exists (select 1 from baseline_approvals x where x.baseline_id = b.id and x.company_id = c.id);
  if v_missing is null and b.status = 'submitted' then update baselines set status = 'approved' where id = b.id; end if;
  return jsonb_build_object('ok', true, 'baseline', b.id, 'status', case when v_missing is null then 'approved' else 'submitted' end, 'still_needed_from', coalesce(v_missing, '[]'));
end $$;
create function nexus.baseline_reject(p_token text, p_baseline uuid, p_reason text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; b baselines;
begin
  select * into a from _op(p_token, array['approve_baseline', 'initialize']); if a.error is not null then return a.error; end if;
  select * into b from baselines where id = p_baseline for update;
  if b.id is null or b.status not in ('submitted', 'approved') then return _no('baseline_closed', 'only a submitted or approved baseline can be rejected'); end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then return _no('bad_request', 'a reason is required'); end if;
  update baselines set status = 'rejected', status_reason = btrim(p_reason) where id = b.id;
  perform _audit(a.actor, 'baseline_rejected', b.warehouse, b.id::text, jsonb_build_object('reason', btrim(p_reason)));
  return jsonb_build_object('ok', true, 'baseline', b.id, 'status', 'rejected');
end $$;

-- CONTROL 2: initialize occupancy from the approved baseline. All or nothing: it runs in one transaction, so an
-- interruption leaves the floor exactly as it was (not initialized, baseline still approved) and it can be run again.
-- It never switches movements on.
create function nexus.baseline_initialize(p_token text, p_baseline uuid, p_fingerprint text, p_backup_ref text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; b baselines; w warehouses; v_problems jsonb; v_n integer; r record; v_p uuid;
begin
  select * into a from _op(p_token, array['initialize']); if a.error is not null then return a.error; end if;
  select * into b from baselines where id = p_baseline for update;
  if b.id is null then return _no('baseline_not_found', 'no such baseline'); end if;
  select * into w from warehouses where code = b.warehouse for update;
  if b.status <> 'approved' then return _no('not_approved', 'this baseline is ' || b.status || '; only a baseline approved by every company can be applied'); end if;
  if exists (select 1 from _required_companies() c where not exists (select 1 from baseline_approvals x where x.baseline_id = b.id and x.company_id = c.id and x.fingerprint = b.fingerprint)) then return _no('not_approved', 'an approval is missing'); end if;
  if lower(btrim(coalesce(p_fingerprint, ''))) <> b.fingerprint then return _no('fingerprint_mismatch', 'that is not this baseline''s fingerprint; nothing was written'); end if;
  if length(btrim(coalesce(p_backup_ref, ''))) < 3 then return _no('backup_required', 'name the verified backup taken before this step'); end if;
  if w.test or w.occupancy_state <> 'not_initialized' or w.moves_enabled then return _no('floor_not_ready', 'the floor must be a real floor, not initialized, with movements off'); end if;
  if exists (select 1 from pallets where warehouse = w.code) or exists (select 1 from occupancy o join locations l on l.id = o.location_id where l.warehouse = w.code) then return _no('floor_not_empty', 'Nexus already holds pallets for this floor'); end if;
  if _map_checksum(w.code) <> b.map_checksum then return _no('map_mismatch', 'the map changed after the count; count again'); end if;
  if exists (select 1 from discrepancies where warehouse = w.code and resolved_at is null) then return _no('open_discrepancies', 'unresolved discrepancies must be settled first'); end if;
  if _baseline_fingerprint(b.map_version, b.map_checksum, b.content) <> b.fingerprint then return _no('fingerprint_mismatch', 'the stored baseline no longer matches its fingerprint'); end if;
  v_problems := _baseline_problems(w.code, b.content);
  if jsonb_array_length(v_problems) > 0 then return _no('baseline_invalid', 'the baseline no longer passes Nexus''s checks', jsonb_build_object('problems', v_problems)); end if;
  for r in select e ->> 'position' pos, p ->> 'company' company, p ->> 'pallet' pallet from jsonb_array_elements(b.content) e, jsonb_array_elements(coalesce(e -> 'pallets', '[]')) p order by 1, 2, 3 loop
    insert into pallets (warehouse, company_id, source_system, external_id) values (w.code, (select id from companies where code = r.company), 'baseline', r.pallet) returning id into v_p;
    insert into occupancy (pallet_id, location_id, placed_by) values (v_p, (select id from locations where warehouse = w.code and code = r.pos), 'baseline:' || b.id);
  end loop;
  select count(*) into v_n from occupancy o join locations l on l.id = o.location_id where l.warehouse = w.code;
  if v_n <> b.pallets then raise exception 'baseline wrote % pallets, expected %', v_n, b.pallets; end if;
  update warehouses set occupancy_state = 'verified', baseline_verified_at = now(), baseline_verified_by = a.actor where code = w.code;
  update baselines set status = 'applied', applied_by = a.id, applied_at = now(), backup_ref = btrim(p_backup_ref) where id = b.id;
  insert into change_log (warehouse, kind) values (w.code, 'occupancy_initialized');
  perform _audit(a.actor, 'occupancy_initialized', w.code, b.id::text, jsonb_build_object('fingerprint', b.fingerprint, 'pallets', v_n, 'backup', btrim(p_backup_ref)));
  return jsonb_build_object('ok', true, 'baseline', b.id, 'pallets', v_n, 'occupancy_state', 'verified', 'moves_enabled', false);
end $$;
-- undo an initialization that has never been used: allowed only while movements have never been switched on since.
create function nexus.baseline_revert(p_token text, p_baseline uuid, p_reason text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; b baselines; w warehouses;
begin
  select * into a from _op(p_token, array['initialize']); if a.error is not null then return a.error; end if;
  select * into b from baselines where id = p_baseline for update;
  if b.id is null or b.status <> 'applied' then return _no('not_applied', 'only an applied baseline can be reverted'); end if;
  select * into w from warehouses where code = b.warehouse for update;
  if length(btrim(coalesce(p_reason, ''))) < 3 then return _no('bad_request', 'a reason is required'); end if;
  if w.moves_enabled or (w.last_unlocked_at is not null and w.last_unlocked_at >= b.applied_at) or exists (select 1 from moves where warehouse = w.code and at >= b.applied_at) then
    return _no('floor_in_use', 'movements have been switched on since this baseline; it can no longer be reverted, only corrected'); end if;
  delete from occupancy o using locations l where l.id = o.location_id and l.warehouse = w.code;
  delete from pallets where warehouse = w.code;
  update warehouses set occupancy_state = 'not_initialized', baseline_verified_at = null, baseline_verified_by = null where code = w.code;
  update baselines set status = 'reverted', status_reason = btrim(p_reason) where id = b.id;
  update unlock_approvals set voided_at = now() where warehouse = w.code and voided_at is null;
  insert into change_log (warehouse, kind) values (w.code, 'occupancy_reverted');
  perform _audit(a.actor, 'occupancy_reverted', w.code, b.id::text, jsonb_build_object('reason', btrim(p_reason)));
  return jsonb_build_object('ok', true, 'baseline', b.id, 'occupancy_state', 'not_initialized');
end $$;

-- CONTROL 3: unlock movements. Its own role and its own approvals: each company gives a go after the floor was
-- initialized, then an operator with the unlock role switches movements on. A stop or a revert cancels every go given.
create function nexus.floor_unlock_approve(p_token text, p_warehouse text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; w warehouses;
begin
  select * into a from _op(p_token, array['approve_baseline']); if a.error is not null then return a.error; end if;
  select * into w from warehouses where code = p_warehouse;
  if w.code is null or w.test then return _no('warehouse_not_found', 'no such real floor'); end if;
  if w.occupancy_state <> 'verified' then return _no('not_initialized', 'the floor has no verified baseline; there is nothing to unlock'); end if;
  if not exists (select 1 from _required_companies() c where c.id = a.company_id) then return _no('forbidden', 'this operator''s company does not approve for this floor'); end if;
  insert into unlock_approvals (warehouse, company_id, operator_id) values (w.code, a.company_id, a.id);
  perform _audit(a.actor, 'unlock_approved', w.code, null, jsonb_build_object('company', (select code from companies where id = a.company_id)));
  return jsonb_build_object('ok', true, 'warehouse', w.code);
end $$;
create function nexus.floor_unlock(p_token text, p_warehouse text, p_confirm text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; w warehouses; v_missing jsonb; v_unverified jsonb;
begin
  select * into a from _op(p_token, array['unlock']); if a.error is not null then return a.error; end if;
  select * into w from warehouses where code = p_warehouse for update;
  if w.code is null or w.test then return _no('warehouse_not_found', 'no such real floor'); end if;
  if w.moves_enabled then return jsonb_build_object('ok', true, 'warehouse', w.code, 'moves_enabled', true, 'changed', false); end if;
  if w.occupancy_state <> 'verified' then return _no('not_initialized', 'movements cannot be switched on before occupancy is initialized from an approved baseline'); end if;
  if coalesce(p_confirm, '') <> 'UNLOCK ' || w.code then return _no('confirmation_required', 'confirm by sending exactly: UNLOCK ' || w.code); end if;
  if exists (select 1 from discrepancies where warehouse = w.code and resolved_at is null) then return _no('open_discrepancies', 'unresolved discrepancies must be settled first'); end if;
  select jsonb_agg(code order by code) into v_unverified from locations where warehouse = w.code and kind in ('pallet', 'staging') and not capacity_verified;
  if v_unverified is not null then return _no('capacity_not_verified', 'every position''s capacity must be verified against the physical specification first', jsonb_build_object('positions', jsonb_array_length(v_unverified))); end if;
  select jsonb_agg(c.code order by c.code) into v_missing from _required_companies() c where not exists (select 1 from unlock_approvals u where u.warehouse = w.code and u.company_id = c.id and u.voided_at is null);
  if v_missing is not null then return _no('unlock_not_approved', 'each company must give its go after the floor was initialized or last stopped', jsonb_build_object('still_needed_from', v_missing)); end if;
  update warehouses set moves_enabled = true, last_unlocked_at = now() where code = w.code;
  insert into change_log (warehouse, kind) values (w.code, 'movements_enabled');
  perform _audit(a.actor, 'movements_enabled', w.code, null, '{}');
  return jsonb_build_object('ok', true, 'warehouse', w.code, 'moves_enabled', true, 'changed', true);
end $$;

-- CONTROL 4: stop movements at once. No approvals, no preconditions, any floor. Reads keep working.
create function nexus.floor_stop(p_token text, p_warehouse text, p_reason text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; w warehouses;
begin
  select * into a from _op(p_token, array['stop']); if a.error is not null then return a.error; end if;
  select * into w from warehouses where code = p_warehouse for update;
  if w.code is null then return _no('warehouse_not_found', 'no such floor'); end if;
  update warehouses set moves_enabled = false, last_stopped_at = now() where code = w.code;
  update unlock_approvals set voided_at = now() where warehouse = w.code and voided_at is null;   -- a stop cancels every go given so far
  if w.moves_enabled then insert into change_log (warehouse, kind) values (w.code, 'movements_stopped'); end if;
  perform _audit(a.actor, 'movements_stopped', w.code, null, jsonb_build_object('reason', coalesce(nullif(btrim(p_reason), ''), '(none given)'), 'was_enabled', w.moves_enabled));
  return jsonb_build_object('ok', true, 'warehouse', w.code, 'moves_enabled', false, 'changed', w.moves_enabled);
end $$;

-- capacity against the physical specification (role: registry). A changed capacity is a changed map: the version moves on.
create function nexus.location_capacity_verify(p_token text, p_warehouse text, p_code text, p_capacity integer, p_spec text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; l locations; v_used integer;
begin
  select * into a from _op(p_token, array['registry']); if a.error is not null then return a.error; end if;
  select * into l from locations where warehouse = p_warehouse and code = upper(btrim(coalesce(p_code, ''))) for update;
  if l.id is null then return _no('location_not_found', 'no such position'); end if;
  if p_capacity is null or p_capacity < 1 then return _no('bad_request', 'capacity is a whole number of pallets, one or more'); end if;
  if length(btrim(coalesce(p_spec, ''))) < 3 then return _no('bad_request', 'say what the capacity was verified against'); end if;
  select count(*) into v_used from occupancy where location_id = l.id;
  if p_capacity < v_used then return _no('capacity_below_occupancy', 'more pallets stand there than that', jsonb_build_object('used', v_used)); end if;
  update locations set capacity = p_capacity, capacity_verified = true, capacity_spec = btrim(p_spec), updated_at = now(), updated_by = a.actor where id = l.id;
  if l.capacity is distinct from p_capacity then
    update warehouses set map_version = map_version + 1 where code = l.warehouse; insert into change_log (warehouse, kind, location_id) values (l.warehouse, 'map_changed', l.id);
  end if;
  perform _audit(a.actor, 'capacity_verified', l.warehouse, l.code, jsonb_build_object('capacity', p_capacity, 'was', l.capacity, 'spec', btrim(p_spec)));
  return jsonb_build_object('ok', true, 'code', l.code, 'capacity', p_capacity, 'map_changed', l.capacity is distinct from p_capacity);
end $$;

create function nexus.discrepancy_open(p_token text, p_warehouse text, p_position text, p_kind text, p_detail text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; v_id bigint;
begin
  select * into a from _op(p_token, array['approve_baseline', 'initialize', 'unlock', 'stop', 'registry']); if a.error is not null then return a.error; end if;
  if not exists (select 1 from warehouses where code = p_warehouse) then return _no('warehouse_not_found', 'no such floor'); end if;
  if length(btrim(coalesce(p_detail, ''))) < 3 or length(btrim(coalesce(p_kind, ''))) < 2 then return _no('bad_request', 'say what kind of discrepancy it is and what was seen'); end if;
  insert into discrepancies (warehouse, position_code, kind, detail, opened_by) values (p_warehouse, nullif(upper(btrim(coalesce(p_position, ''))), ''), btrim(p_kind), btrim(p_detail), a.id) returning id into v_id;
  perform _audit(a.actor, 'discrepancy_opened', p_warehouse, v_id::text, jsonb_build_object('position', p_position, 'kind', p_kind));
  return jsonb_build_object('ok', true, 'discrepancy', v_id);
end $$;
create function nexus.discrepancy_resolve(p_token text, p_id bigint, p_resolution text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; d discrepancies;
begin
  select * into a from _op(p_token, array['approve_baseline', 'initialize']); if a.error is not null then return a.error; end if;
  select * into d from discrepancies where id = p_id for update;
  if d.id is null or d.resolved_at is not null then return _no('not_open', 'no open discrepancy with that number'); end if;
  if length(btrim(coalesce(p_resolution, ''))) < 3 then return _no('bad_request', 'say how it was settled'); end if;
  update discrepancies set resolved_by = a.id, resolved_at = now(), resolution = btrim(p_resolution) where id = d.id;
  perform _audit(a.actor, 'discrepancy_resolved', d.warehouse, d.id::text, jsonb_build_object('resolution', btrim(p_resolution)));
  return jsonb_build_object('ok', true, 'discrepancy', d.id);
end $$;

-- CONTROL 5: one view of a floor: state, baseline and who approved, unlock approvals, open discrepancies, audit history.
create function nexus.floor_status(p_token text, p_warehouse text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; w warehouses;
begin
  select * into a from _op(p_token, array['view', 'approve_baseline', 'initialize', 'unlock', 'stop', 'registry']); if a.error is not null then return a.error; end if;
  select * into w from warehouses where code = p_warehouse; if w.code is null then return _no('warehouse_not_found', 'no such floor'); end if;
  return jsonb_build_object('ok', true, 'warehouse', w.code, 'test', w.test, 'occupancy_state', w.occupancy_state, 'moves_enabled', w.moves_enabled, 'map_version', w.map_version,
    'baseline_verified_at', w.baseline_verified_at, 'last_unlocked_at', w.last_unlocked_at, 'last_stopped_at', w.last_stopped_at,
    'occupied', (select count(*) from occupancy o join locations l on l.id = o.location_id where l.warehouse = w.code),
    'capacity_unverified', (select count(*) from locations where warehouse = w.code and kind in ('pallet', 'staging') and not capacity_verified),
    'baselines', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'status', b.status, 'fingerprint', b.fingerprint, 'pallets', b.pallets, 'submitted_at', b.submitted_at, 'submitted_by', so.name, 'applied_at', b.applied_at, 'reason', b.status_reason,
        'approvals', (select coalesce(jsonb_agg(jsonb_build_object('company', c.code, 'by', o.name, 'at', x.at) order by c.code), '[]') from baseline_approvals x join companies c on c.id = x.company_id join operators o on o.id = x.operator_id where x.baseline_id = b.id)) order by b.submitted_at desc), '[]')
      from baselines b join operators so on so.id = b.submitted_by where b.warehouse = w.code),
    'unlock_approvals', (select coalesce(jsonb_agg(jsonb_build_object('company', c.code, 'by', o.name, 'at', u.at) order by u.at desc), '[]') from unlock_approvals u join companies c on c.id = u.company_id join operators o on o.id = u.operator_id where u.warehouse = w.code),
    'open_discrepancies', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'position', d.position_code, 'kind', d.kind, 'detail', d.detail, 'opened_by', o.name, 'opened_at', d.opened_at) order by d.id), '[]') from discrepancies d join operators o on o.id = d.opened_by where d.warehouse = w.code and d.resolved_at is null),
    'audit', (select coalesce(jsonb_agg(jsonb_build_object('at', x.at, 'actor', x.actor, 'action', x.action, 'target', x.target, 'detail', x.after) order by x.id desc), '[]') from (select * from audit_log where warehouse = w.code order by id desc limit 200) x));
end $$;

-- a digest of everything Nexus holds, table by table: taken before a backup and after a restore, the two must be equal
create function nexus.snapshot_digest() returns jsonb language plpgsql set search_path to 'nexus' as $$
declare t record; v jsonb := '{}'; n bigint; h text;
begin
  for t in select c.relname from pg_class c where c.relnamespace = 'nexus'::regnamespace and c.relkind = 'r' order by 1 loop
    execute format('select count(*), coalesce(md5(string_agg(md5(x::text), '''' order by md5(x::text))), '''') from nexus.%I x', t.relname) into n, h;
    v := v || jsonb_build_object(t.relname, jsonb_build_object('rows', n, 'digest', h));
  end loop;
  return v || jsonb_build_object('_all', md5(v::text));
end $$;
