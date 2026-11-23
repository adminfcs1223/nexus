-- Administrator controls, hardened (2026-11-23). Loaded after 004 and 005. Adds, without changing the movement engine:
--   1. operators are assigned to named floors; a synthetic operator can act only on a rehearsal floor, a real one never on it
--   2. table-level guards: a real floor's movements can be switched on only by floor_unlock, its occupancy marked verified
--      only by baseline_initialize, and ANY switch-off (by a control or by a plain UPDATE) cancels every unlock go and is recorded
--   3. refused attempts are recorded with who, when, which floor and why
--   4. two service roles: nexus_api may run only the integration calls, nexus_admin_api only the controls; nobody else,
--      PUBLIC included, may run anything in this schema
alter table nexus.warehouses add column if not exists rehearsal boolean not null default false;
alter table nexus.warehouses drop constraint if exists warehouses_rehearsal_not_test; alter table nexus.warehouses add constraint warehouses_rehearsal_not_test check (not (rehearsal and test));
alter table nexus.operators add column if not exists floors text[] not null default '{}', add column if not exists synthetic boolean not null default false;

-- who is using a control; needs any one of p_roles. A known operator turned away for a missing role is recorded.
create or replace function nexus._op(p_token text, p_roles text[], out id uuid, out company_id uuid, out name text, out actor text, out error jsonb) language plpgsql set search_path to 'nexus' as $$
declare o operators;
begin
  select * into o from operators where token_hash = _hash(p_token) and coalesce(p_token, '') <> '';
  if o.id is null or not o.active then
    insert into audit_log (actor, action, target, after) values ('unknown operator', 'control_refused', null, jsonb_build_object('reason', 'unauthorized', 'needs', p_roles));
    error := _no('unauthorized', 'unknown or inactive operator'); return;
  end if;
  if not (o.roles && p_roles) then
    insert into audit_log (actor, action, target, after) values ('op:' || o.id || ' ' || o.name, 'control_refused', null, jsonb_build_object('reason', 'forbidden', 'needs', p_roles, 'has', o.roles));
    error := _no('forbidden', 'this operator may not use this control (needs ' || array_to_string(p_roles, ' or ') || ')'); return;
  end if;
  update operators set last_used_at = now() where operators.id = o.id;
  id := o.id; company_id := o.company_id; name := o.name; actor := 'op:' || o.id || ' ' || o.name;
end $$;
-- may this operator act on this floor? null = yes. Checked by every control once the floor is known.
create or replace function nexus._floor_gate(p_op uuid, p_actor text, p_warehouse text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare o operators; w warehouses; v jsonb;
begin
  select * into o from operators where id = p_op; select * into w from warehouses where code = p_warehouse;
  if w.code is null or not (p_warehouse = any (o.floors)) then v := _no('wrong_floor', 'this operator is not assigned to that floor');
  elsif o.synthetic and not w.rehearsal then v := _no('synthetic_operator', 'a synthetic operator can act only on a rehearsal floor');
  elsif not o.synthetic and w.rehearsal then v := _no('rehearsal_floor', 'a rehearsal floor takes synthetic operators only');
  end if;
  if v is not null then insert into audit_log (actor, action, warehouse, target, after) values (p_actor, 'control_refused', p_warehouse, null, jsonb_build_object('reason', v ->> 'error')); end if;
  return v;
end $$;
drop function if exists nexus.operator_create(text, text, text, text[]);
create or replace function nexus.operator_create(p_actor text, p_company text, p_name text, p_roles text[], p_floors text[], p_synthetic boolean) returns text language plpgsql set search_path to 'nexus' as $$
declare k text := 'nxo_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''); v_co uuid; v_id uuid; f text;
begin
  if p_company is not null then select id into strict v_co from companies where code = p_company; end if;
  if p_floors is null or cardinality(p_floors) = 0 then raise exception 'an operator is assigned to at least one floor'; end if;
  foreach f in array p_floors loop
    if not exists (select 1 from warehouses w where w.code = f and w.rehearsal = coalesce(p_synthetic, false)) then raise exception 'floor % does not exist or is not a % floor', f, case when p_synthetic then 'rehearsal' else 'real' end; end if;
  end loop;
  insert into operators (company_id, name, roles, token_hash, floors, synthetic) values (v_co, btrim(p_name), p_roles, _hash(k), p_floors, coalesce(p_synthetic, false)) returning id into v_id;
  perform _audit(p_actor, 'operator_created', null, v_id::text, jsonb_build_object('name', btrim(p_name), 'company', p_company, 'roles', p_roles, 'floors', p_floors, 'synthetic', coalesce(p_synthetic, false)));
  return k;
end $$;

-- table-level guards on the floor row itself, whatever path a change arrives by
create or replace function nexus._warehouse_guard() returns trigger language plpgsql set search_path to 'nexus' as $$
declare v_actor text := coalesce(nullif(current_setting('nexus.actor', true), ''), 'db:' || session_user);
begin
  if tg_op = 'INSERT' then
    if not new.test and (new.moves_enabled or new.occupancy_state <> 'not_initialized') then raise exception 'a real floor is created locked and not initialized'; end if;
    return new;
  end if;
  if new.test is distinct from old.test or new.rehearsal is distinct from old.rehearsal or new.code is distinct from old.code then raise exception 'a floor''s code and kind cannot be changed'; end if;
  if not new.test and new.occupancy_state = 'verified' and old.occupancy_state <> 'verified' and coalesce(current_setting('nexus.init_ok', true), '') <> new.code then
    raise exception 'occupancy is marked verified only by initializing an approved baseline'; end if;
  if not new.test and new.moves_enabled and not old.moves_enabled and coalesce(current_setting('nexus.unlock_ok', true), '') <> new.code then
    raise exception 'movements on a real floor are switched on only by the unlock control'; end if;
  if (old.moves_enabled and not new.moves_enabled) or (old.occupancy_state = 'verified' and new.occupancy_state <> 'verified') then
    -- every switch-off cancels every go given so far and is recorded, even a plain UPDATE made with no control at all
    update unlock_approvals set voided_at = now() where warehouse = new.code and voided_at is null;
    if old.moves_enabled and not new.moves_enabled then
      new.last_stopped_at := now(); insert into change_log (warehouse, kind) values (new.code, 'movements_stopped');
      if coalesce(current_setting('nexus.actor', true), '') = '' then insert into audit_log (actor, action, warehouse, target, after) values (v_actor, 'movements_stopped', new.code, null, jsonb_build_object('reason', '(switched off directly in the database)', 'was_enabled', true)); end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists warehouse_guard on nexus.warehouses;
create trigger warehouse_guard before insert or update on nexus.warehouses for each row execute function nexus._warehouse_guard();

-- CONTROL 3b: unlock. As before, plus: it is the only path the table accepts for switching a real floor on.
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
-- CONTROL 4: stop. Immediate, no approvals. The table guard cancels the gos and writes the feed entry.
create or replace function nexus.floor_stop(p_token text, p_warehouse text, p_reason text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; g jsonb; w warehouses;
begin
  select * into a from _op(p_token, array['stop']); if a.error is not null then return a.error; end if;
  g := _floor_gate(a.id, a.actor, p_warehouse); if g is not null then return g; end if;
  select * into w from warehouses where code = p_warehouse for update;
  perform set_config('nexus.actor', a.actor, true);
  update warehouses set moves_enabled = false, last_stopped_at = now() where code = w.code;
  update unlock_approvals set voided_at = now() where warehouse = w.code and voided_at is null;   -- also when the floor was already stopped
  perform set_config('nexus.actor', '', true);
  perform _audit(a.actor, 'movements_stopped', w.code, null, jsonb_build_object('reason', coalesce(nullif(btrim(p_reason), ''), '(none given)'), 'was_enabled', w.moves_enabled));
  return jsonb_build_object('ok', true, 'warehouse', w.code, 'moves_enabled', false, 'changed', w.moves_enabled);
end $$;
-- Stop with no operator token and no administrator interface: run by the database owner, straight in SQL.
--   select nexus.break_glass_stop('HILLSBOROUGH', 'why');
-- No service role may run it. (A plain UPDATE that switches movements off is equally safe: the table guard handles it.)
create or replace function nexus.break_glass_stop(p_warehouse text, p_reason text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare w warehouses;
begin
  select * into w from warehouses where code = p_warehouse for update; if w.code is null then return _no('warehouse_not_found', 'no such floor'); end if;
  perform set_config('nexus.actor', 'db:' || session_user, true);
  update warehouses set moves_enabled = false, last_stopped_at = now() where code = w.code;
  update unlock_approvals set voided_at = now() where warehouse = w.code and voided_at is null;
  perform set_config('nexus.actor', '', true);
  perform _audit('db:' || session_user, 'movements_stopped', w.code, null, jsonb_build_object('reason', coalesce(nullif(btrim(p_reason), ''), '(none given)'), 'was_enabled', w.moves_enabled, 'break_glass', true));
  return jsonb_build_object('ok', true, 'warehouse', w.code, 'moves_enabled', false, 'changed', w.moves_enabled);
end $$;

-- REVIEW: one baseline as an approver needs to see it. A company's approver sees its own pallet ids and, for the other
-- company, the position and company only. The fingerprint covers everything.
create or replace function nexus.baseline_review(p_token text, p_warehouse text, p_baseline uuid) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; g jsonb; b baselines; v_code text;
begin
  select * into a from _op(p_token, array['view', 'approve_baseline', 'initialize', 'unlock', 'stop', 'registry']); if a.error is not null then return a.error; end if;
  g := _floor_gate(a.id, a.actor, p_warehouse); if g is not null then return g; end if;
  select * into b from baselines where id = p_baseline and warehouse = p_warehouse;
  if b.id is null then return _no('baseline_not_found', 'no such baseline on this floor'); end if;
  select code into v_code from companies where id = a.company_id;
  return jsonb_build_object('ok', true, 'baseline', b.id, 'warehouse', b.warehouse, 'status', b.status, 'reason', b.status_reason, 'fingerprint', b.fingerprint, 'map_version', b.map_version,
    'map_is_current', b.map_checksum = _map_checksum(b.warehouse), 'fingerprint_matches_contents', _baseline_fingerprint(b.map_version, b.map_checksum, b.content) = b.fingerprint,
    'problems_now', _baseline_problems(b.warehouse, b.content), 'counters', b.counters, 'positions', b.positions, 'pallets', b.pallets, 'submitted_at', b.submitted_at,
    'submitted_by', (select name from operators where id = b.submitted_by), 'you_submitted_it', b.submitted_by = a.id,
    'by_company', (select coalesce(jsonb_object_agg(x.company, x.n), '{}') from (select p ->> 'company' company, count(*) n from jsonb_array_elements(b.content) e, jsonb_array_elements(coalesce(e -> 'pallets', '[]')) p group by 1) x),
    'occupied', (select coalesce(jsonb_agg(jsonb_build_object('position', e ->> 'position', 'company', p ->> 'company') || case when a.company_id is null or p ->> 'company' = v_code then jsonb_build_object('pallet', p ->> 'pallet') else '{}'::jsonb end order by e ->> 'position', p ->> 'company', p ->> 'pallet'), '[]')
      from jsonb_array_elements(b.content) e, jsonb_array_elements(coalesce(e -> 'pallets', '[]')) p),
    'approvals', (select coalesce(jsonb_agg(jsonb_build_object('company', c.code, 'by', o.name, 'at', x.at) order by c.code), '[]') from baseline_approvals x join companies c on c.id = x.company_id join operators o on o.id = x.operator_id where x.baseline_id = b.id),
    'still_needed_from', (select coalesce(jsonb_agg(c.code order by c.code), '[]') from _required_companies() c where not exists (select 1 from baseline_approvals x where x.baseline_id = b.id and x.company_id = c.id)),
    'open_discrepancies', (select count(*) from discrepancies where warehouse = b.warehouse and resolved_at is null));
end $$;

-- the ten controls from 004, each now asking whether its operator is assigned to the floor it is about to act on
create or replace function nexus.baseline_submit(p_token text, p_warehouse text, p_report jsonb) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; g jsonb; w warehouses; v_content jsonb := p_report -> 'baseline'; v_fp text; v_problems jsonb; v_id uuid; c1 jsonb := p_report #> '{counters,count_1}'; c2 jsonb := p_report #> '{counters,count_2}';
begin
  select * into a from _op(p_token, array['initialize', 'approve_baseline']); if a.error is not null then return a.error; end if;
  g := _floor_gate(a.id, a.actor, p_warehouse); if g is not null then return g; end if;
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

create or replace function nexus.floor_unlock_approve(p_token text, p_warehouse text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; g jsonb; w warehouses;
begin
  select * into a from _op(p_token, array['approve_baseline']); if a.error is not null then return a.error; end if;
  g := _floor_gate(a.id, a.actor, p_warehouse); if g is not null then return g; end if;
  select * into w from warehouses where code = p_warehouse;
  if w.code is null or w.test then return _no('warehouse_not_found', 'no such real floor'); end if;
  if w.occupancy_state <> 'verified' then return _no('not_initialized', 'the floor has no verified baseline; there is nothing to unlock'); end if;
  if not exists (select 1 from _required_companies() c where c.id = a.company_id) then return _no('forbidden', 'this operator''s company does not approve for this floor'); end if;
  if exists (select 1 from unlock_approvals u where u.warehouse = w.code and u.operator_id = a.id and u.voided_at is null) then return jsonb_build_object('ok', true, 'warehouse', w.code, 'already_given', true); end if;   -- sent again: nothing new
  insert into unlock_approvals (warehouse, company_id, operator_id) values (w.code, a.company_id, a.id);
  perform _audit(a.actor, 'unlock_approved', w.code, null, jsonb_build_object('company', (select code from companies where id = a.company_id)));
  return jsonb_build_object('ok', true, 'warehouse', w.code, 'already_given', false);
end $$;

create or replace function nexus.location_capacity_verify(p_token text, p_warehouse text, p_code text, p_capacity integer, p_spec text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; g jsonb; l locations; v_used integer;
begin
  select * into a from _op(p_token, array['registry']); if a.error is not null then return a.error; end if;
  g := _floor_gate(a.id, a.actor, p_warehouse); if g is not null then return g; end if;
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

create or replace function nexus.discrepancy_open(p_token text, p_warehouse text, p_position text, p_kind text, p_detail text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; g jsonb; v_id bigint;
begin
  select * into a from _op(p_token, array['approve_baseline', 'initialize', 'unlock', 'stop', 'registry']); if a.error is not null then return a.error; end if;
  g := _floor_gate(a.id, a.actor, p_warehouse); if g is not null then return g; end if;
  if not exists (select 1 from warehouses where code = p_warehouse) then return _no('warehouse_not_found', 'no such floor'); end if;
  if length(btrim(coalesce(p_detail, ''))) < 3 or length(btrim(coalesce(p_kind, ''))) < 2 then return _no('bad_request', 'say what kind of discrepancy it is and what was seen'); end if;
  insert into discrepancies (warehouse, position_code, kind, detail, opened_by) values (p_warehouse, nullif(upper(btrim(coalesce(p_position, ''))), ''), btrim(p_kind), btrim(p_detail), a.id) returning id into v_id;
  perform _audit(a.actor, 'discrepancy_opened', p_warehouse, v_id::text, jsonb_build_object('position', p_position, 'kind', p_kind));
  return jsonb_build_object('ok', true, 'discrepancy', v_id);
end $$;

create or replace function nexus.floor_status(p_token text, p_warehouse text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; g jsonb; w warehouses;
begin
  select * into a from _op(p_token, array['view', 'approve_baseline', 'initialize', 'unlock', 'stop', 'registry']); if a.error is not null then return a.error; end if;
  g := _floor_gate(a.id, a.actor, p_warehouse); if g is not null then return g; end if;
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

create or replace function nexus.baseline_approve(p_token text, p_baseline uuid, p_fingerprint text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; g jsonb; b baselines; v_missing jsonb;
begin
  select * into a from _op(p_token, array['approve_baseline']); if a.error is not null then return a.error; end if;
  select * into b from baselines where id = p_baseline for update;
  if b.id is not null then g := _floor_gate(a.id, a.actor, b.warehouse); if g is not null then return g; end if; end if;
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

create or replace function nexus.baseline_reject(p_token text, p_baseline uuid, p_reason text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; g jsonb; b baselines;
begin
  select * into a from _op(p_token, array['approve_baseline', 'initialize']); if a.error is not null then return a.error; end if;
  select * into b from baselines where id = p_baseline for update;
  if b.id is not null then g := _floor_gate(a.id, a.actor, b.warehouse); if g is not null then return g; end if; end if;
  if b.id is null or b.status not in ('submitted', 'approved') then return _no('baseline_closed', 'only a submitted or approved baseline can be rejected'); end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then return _no('bad_request', 'a reason is required'); end if;
  update baselines set status = 'rejected', status_reason = btrim(p_reason) where id = b.id;
  perform _audit(a.actor, 'baseline_rejected', b.warehouse, b.id::text, jsonb_build_object('reason', btrim(p_reason)));
  return jsonb_build_object('ok', true, 'baseline', b.id, 'status', 'rejected');
end $$;

create or replace function nexus.baseline_initialize(p_token text, p_baseline uuid, p_fingerprint text, p_backup_ref text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; g jsonb; b baselines; w warehouses; v_problems jsonb; v_n integer; r record; v_p uuid;
begin
  select * into a from _op(p_token, array['initialize']); if a.error is not null then return a.error; end if;
  select * into b from baselines where id = p_baseline for update;
  if b.id is not null then g := _floor_gate(a.id, a.actor, b.warehouse); if g is not null then return g; end if; end if;
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
  perform set_config('nexus.init_ok', w.code, true);
  update warehouses set occupancy_state = 'verified', baseline_verified_at = now(), baseline_verified_by = a.actor where code = w.code;
  perform set_config('nexus.init_ok', '', true);
  update baselines set status = 'applied', applied_by = a.id, applied_at = now(), backup_ref = btrim(p_backup_ref) where id = b.id;
  insert into change_log (warehouse, kind) values (w.code, 'occupancy_initialized');
  perform _audit(a.actor, 'occupancy_initialized', w.code, b.id::text, jsonb_build_object('fingerprint', b.fingerprint, 'pallets', v_n, 'backup', btrim(p_backup_ref)));
  return jsonb_build_object('ok', true, 'baseline', b.id, 'pallets', v_n, 'occupancy_state', 'verified', 'moves_enabled', false);
end $$;

create or replace function nexus.baseline_revert(p_token text, p_baseline uuid, p_reason text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; g jsonb; b baselines; w warehouses;
begin
  select * into a from _op(p_token, array['initialize']); if a.error is not null then return a.error; end if;
  select * into b from baselines where id = p_baseline for update;
  if b.id is not null then g := _floor_gate(a.id, a.actor, b.warehouse); if g is not null then return g; end if; end if;
  if b.id is null or b.status <> 'applied' then return _no('not_applied', 'only an applied baseline can be reverted'); end if;
  select * into w from warehouses where code = b.warehouse for update;
  if length(btrim(coalesce(p_reason, ''))) < 3 then return _no('bad_request', 'a reason is required'); end if;
  if w.moves_enabled or (w.last_unlocked_at is not null and w.last_unlocked_at >= b.applied_at) or exists (select 1 from moves where warehouse = w.code and at >= b.applied_at) then
    return _no('floor_in_use', 'movements have been switched on since this baseline; it can no longer be reverted, only corrected'); end if;
  delete from occupancy o using locations l where l.id = o.location_id and l.warehouse = w.code;
  delete from pallets where warehouse = w.code;
  perform set_config('nexus.actor', a.actor, true);
  update warehouses set occupancy_state = 'not_initialized', baseline_verified_at = null, baseline_verified_by = null where code = w.code;
  update baselines set status = 'reverted', status_reason = btrim(p_reason) where id = b.id;
  update unlock_approvals set voided_at = now() where warehouse = w.code and voided_at is null;
  insert into change_log (warehouse, kind) values (w.code, 'occupancy_reverted');
  perform _audit(a.actor, 'occupancy_reverted', w.code, b.id::text, jsonb_build_object('reason', btrim(p_reason)));
  return jsonb_build_object('ok', true, 'baseline', b.id, 'occupancy_state', 'not_initialized');
end $$;

create or replace function nexus.discrepancy_resolve(p_token text, p_id bigint, p_resolution text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; g jsonb; d discrepancies;
begin
  select * into a from _op(p_token, array['approve_baseline', 'initialize']); if a.error is not null then return a.error; end if;
  select * into d from discrepancies where id = p_id for update;
  if d.id is not null then g := _floor_gate(a.id, a.actor, d.warehouse); if g is not null then return g; end if; end if;
  if d.id is null or d.resolved_at is not null then return _no('not_open', 'no open discrepancy with that number'); end if;
  if length(btrim(coalesce(p_resolution, ''))) < 3 then return _no('bad_request', 'say how it was settled'); end if;
  update discrepancies set resolved_by = a.id, resolved_at = now(), resolution = btrim(p_resolution) where id = d.id;
  perform _audit(a.actor, 'discrepancy_resolved', d.warehouse, d.id::text, jsonb_build_object('resolution', btrim(p_resolution)));
  return jsonb_build_object('ok', true, 'discrepancy', d.id);
end $$;

-- A throwaway floor for rehearsing the controls: the same map as a real floor, real-floor rules (locked, not initialized),
-- synthetic operators only. Database owner only. Its code always starts with REHEARSAL-.
create or replace function nexus.rehearsal_floor_create(p_code text, p_like text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare s warehouses;
begin
  if p_code !~ '^REHEARSAL-[A-Z0-9]{1,12}$' then raise exception 'a rehearsal floor''s code starts with REHEARSAL-'; end if;
  select * into strict s from warehouses where code = p_like and not rehearsal;
  insert into warehouses (code, name, test, rehearsal, occupancy_state, moves_enabled, map_version, landmarks, layout) values (p_code, 'Rehearsal copy of ' || s.code || ' (synthetic operators only)', false, true, 'not_initialized', false, s.map_version, s.landmarks, s.layout);
  insert into locations (code, kind, warehouse, zone, capacity, status, map_block, map_col, map_row, map_x, map_y) select code, kind, p_code, zone, capacity, status, map_block, map_col, map_row, map_x, map_y from locations where warehouse = s.code;
  perform _audit('db:' || session_user, 'rehearsal_floor_created', p_code, null, jsonb_build_object('like', s.code));
  return jsonb_build_object('ok', true, 'warehouse', p_code);
end $$;

-- ───────── who may run what ─────────
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'nexus_api') then create role nexus_api nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'nexus_admin_api') then create role nexus_admin_api nologin; end if;
end $$;
-- which function belongs to which service. Anything not listed is internal: no service role, and not PUBLIC, may run it.
create or replace function nexus._service_functions(out fn text, out service text) returns setof record language sql immutable as $$
  select f, 'nexus_api' from unnest(array['api_place', 'api_occupancy', 'api_changes', 'api_moves', 'api_map', 'api_calendar', 'api_calendar_put']) f
  union all select f, 'nexus_admin_api' from unnest(array['baseline_submit', 'baseline_review', 'baseline_approve', 'baseline_reject', 'baseline_initialize', 'baseline_revert', 'floor_unlock_approve', 'floor_unlock', 'floor_stop',
    'location_capacity_verify', 'discrepancy_open', 'discrepancy_resolve', 'floor_status']) f $$;
do $$ declare r record; begin
  revoke all on schema nexus from public; revoke all on all tables in schema nexus from public; revoke all on all sequences in schema nexus from public;
  revoke all on all functions in schema nexus from public;
  for r in select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role', 'nexus_api', 'nexus_admin_api') loop
    execute format('revoke all on schema nexus from %I', r.rolname); execute format('revoke all on all tables in schema nexus from %I', r.rolname);
    execute format('revoke all on all sequences in schema nexus from %I', r.rolname); execute format('revoke all on all functions in schema nexus from %I', r.rolname);
  end loop;
  for r in select c.oid::regclass t from pg_class c where c.relnamespace = 'nexus'::regnamespace and c.relkind = 'r' loop execute format('alter table %s enable row level security', r.t); end loop;
  grant usage on schema nexus to nexus_api, nexus_admin_api;
  -- a service function runs with the owner's rights (the service role has none of its own on any table) on a fixed search path
  for r in select p.oid::regprocedure sig, s.service from pg_proc p join nexus._service_functions() s on s.fn = p.proname where p.pronamespace = 'nexus'::regnamespace loop
    execute format('alter function %s security definer set search_path = nexus, pg_temp', r.sig); execute format('grant execute on function %s to %I', r.sig, r.service);
  end loop;
end $$;
-- The audit: every way something in this schema could be run or read by someone who should not. Empty list = sound.
create or replace function nexus.permission_audit() returns jsonb language sql stable set search_path to 'nexus' as $$
  with f as (select p.oid, p.proname, p.oid::regprocedure::text sig, p.prosecdef, p.proconfig, p.proacl, (select service from nexus._service_functions() s where s.fn = p.proname) service from pg_proc p where p.pronamespace = 'nexus'::regnamespace),
  g as (select f.*, a.grantee, case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end who from f left join lateral aclexplode(f.proacl) a on a.privilege_type = 'EXECUTE'),
  problems as (
    select 'function_default_acl' code, sig what, 'no explicit permissions: PostgreSQL lets everyone run it' detail from f where proacl is null
    union all select 'function_public', sig, 'PUBLIC may run it' from g where who = 'PUBLIC'
    union all select 'function_wrong_role', sig, who || ' may run it' from g where who is not null and who <> 'PUBLIC' and grantee <> (select relowner from pg_class where oid = 'nexus.warehouses'::regclass) and who is distinct from service
    union all select 'service_function_not_granted', sig, service || ' cannot run its own call' from f where service is not null and not has_function_privilege(service, f.oid, 'execute')
    union all select 'service_function_not_definer', sig, 'runs with the caller''s rights' from f where service is not null and not prosecdef
    union all select 'service_function_search_path', sig, 'search path is not pinned' from f where service is not null and not coalesce(proconfig @> array['search_path=nexus, pg_temp'], false)
    union all select 'internal_function_definer', sig, 'an internal function must not run with the owner''s rights' from f where service is null and prosecdef
    union all select 'role_can_run', f.sig, r.rolname || ' may run it' from f cross join pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'nexus_api', 'nexus_admin_api') and r.rolname is distinct from f.service and has_function_privilege(r.oid, f.oid, 'execute')
    union all select 'table_readable', c.oid::regclass::text, r.rolname || ' has ' || p.priv from pg_class c cross join pg_roles r cross join (values ('select'), ('insert'), ('update'), ('delete')) p(priv)
      where c.relnamespace = 'nexus'::regnamespace and c.relkind in ('r', 'v') and r.rolname in ('anon', 'authenticated', 'service_role', 'nexus_api', 'nexus_admin_api') and has_table_privilege(r.oid, c.oid, p.priv)
    union all select 'table_public', c.oid::regclass::text, 'PUBLIC has a table privilege' from pg_class c, lateral aclexplode(c.relacl) a where c.relnamespace = 'nexus'::regnamespace and c.relkind in ('r', 'v', 'S') and a.grantee = 0
    union all select 'schema_usage', 'schema nexus', r.rolname || ' may use the schema' from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') and has_schema_privilege(r.oid, 'nexus', 'usage')
    union all select 'schema_public', 'schema nexus', 'PUBLIC may use the schema' from pg_namespace n, lateral aclexplode(n.nspacl) a where n.nspname = 'nexus' and a.grantee = 0
    union all select 'rls_off', c.oid::regclass::text, 'row security is off' from pg_class c where c.relnamespace = 'nexus'::regnamespace and c.relkind = 'r' and not c.relrowsecurity and exists (select 1 from pg_roles where rolname = 'anon'))
  select jsonb_build_object('ok', not exists (select 1 from problems), 'functions', (select count(*) from f), 'service_functions', (select count(*) from f where service is not null),
    'problems', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'what', what, 'detail', detail) order by code, what, detail), '[]') from problems)) $$;
revoke all on all functions in schema nexus from public;
do $$ declare r record; begin
  for r in select p.oid::regprocedure sig, s.service from pg_proc p join nexus._service_functions() s on s.fn = p.proname where p.pronamespace = 'nexus'::regnamespace loop execute format('grant execute on function %s to %I', r.sig, r.service); end loop;
end $$;
