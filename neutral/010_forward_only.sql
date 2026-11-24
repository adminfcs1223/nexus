-- Forward-only launch (owner decision, 2026-11-24). Loaded after 007.
-- A real floor may start blank and be filled by genuine receiving, without a full historical count, in a new occupancy
-- state `forward_only`. On such a floor every assign and move must carry a per-location confirmation that a person checked
-- the destination is physically empty; Nexus records who confirmed with the movement. Blank in Nexus does not mean empty on
-- the floor. Test floors and the count-based `verified` path are unchanged. No existing call changes shape.
alter table nexus.warehouses drop constraint warehouses_occupancy_state_check, drop constraint warehouses_check1;
alter table nexus.warehouses add constraint warehouses_occupancy_state_check check (occupancy_state in ('not_initialized', 'verified', 'synthetic', 'forward_only')),
  add constraint warehouses_check1 check (test or not moves_enabled or occupancy_state in ('verified', 'forward_only'));
alter table nexus.moves add column if not exists confirmation jsonb;
create or replace function nexus.place(p_requester text, p_warehouse text, p_company uuid, p_source text, p_kind text, p_external_id text, p_to text, p_expected_from text, p_idem text) returns jsonb
language plpgsql set search_path to 'nexus' as $$
declare v_ext text := btrim(coalesce(p_external_id, '')); v_idem text := btrim(coalesce(p_idem, '')); w warehouses; m moves; p pallets; l locations; o occupancy; v_from locations; v_used int; r jsonb; v_seq bigint;
  v_to text := nullif(upper(btrim(coalesce(p_to, ''))), ''); v_exp text := nullif(upper(btrim(coalesce(p_expected_from, ''))), ''); v_req jsonb; v_confirm jsonb;
begin
  if p_kind not in ('assign', 'move', 'release') then return jsonb_build_object('ok', false, 'error', 'bad_request', 'message', 'kind is assign, move or release'); end if;
  if v_idem = '' or length(v_idem) > 128 then return jsonb_build_object('ok', false, 'error', 'bad_request', 'message', 'an idempotency key of 1 to 128 characters is required'); end if;
  if v_ext = '' or length(v_ext) > 64 then return jsonb_build_object('ok', false, 'error', 'bad_request', 'message', 'the pallet id is required'); end if;
  -- what counts as "the same request": the positions that matter for this action (assign: to · move: to and from · release: from)
  v_req := case p_kind when 'assign' then jsonb_build_object('to', v_to) when 'move' then jsonb_build_object('to', v_to, 'from', v_exp) else jsonb_build_object('from', v_exp) end;
  select * into w from warehouses where code = p_warehouse;
  if w.code is null then return jsonb_build_object('ok', false, 'error', 'bad_request', 'message', 'unknown warehouse'); end if;
  -- the prelaunch lock: nothing is recorded, so the same request can be sent again once the floor is live
  if not w.moves_enabled then return jsonb_build_object('ok', false, 'error', 'occupancy_not_initialized', 'occupancy_state', w.occupancy_state,
    'message', 'Assign, move and release are switched off on this floor until its occupancy baseline is entered and verified.'); end if;
  -- forward-only floor: a pallet goes into a position only after a person on the floor has confirmed it is physically empty.
  -- The confirmation arrives through api_place_confirmed; without it nothing is recorded, so the same key can be sent again.
  if w.occupancy_state = 'forward_only' and p_kind in ('assign', 'move') then
    begin v_confirm := nullif(current_setting('nexus.confirm', true), '')::jsonb; exception when others then v_confirm := null; end;
    if coalesce(v_confirm ->> 'empty', '') <> 'true' or length(btrim(coalesce(v_confirm ->> 'by', ''))) not between 2 and 80 then
      return jsonb_build_object('ok', false, 'error', 'location_not_confirmed', 'message', 'Confirm on the floor that the destination is physically empty, then send confirmed_empty: true and confirmed_by: <who checked>.');
    end if;
    v_confirm := jsonb_build_object('empty', true, 'by', btrim(v_confirm ->> 'by'), 'location', v_to, 'at', now());
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_requester || chr(31) || v_idem, 0));   -- the same key twice at the same moment: one waits for the other's row
  select * into m from moves where requester = p_requester and idempotency_key = v_idem;
  if found then
    if m.kind <> p_kind or m.external_id <> v_ext or (m.request is not null and m.request <> v_req) then return jsonb_build_object('ok', false, 'error', 'idempotency_key_reused', 'message', 'this key was already used for a different request'); end if;
    return m.response || jsonb_build_object('replayed', true);
  end if;

  if p_kind = 'assign' then insert into pallets (warehouse, company_id, source_system, external_id) values (w.code, p_company, p_source, v_ext) on conflict (warehouse, company_id, external_id) do nothing; end if;
  select * into p from pallets where warehouse = w.code and company_id = p_company and external_id = v_ext for update;
  if p.id is null then r := jsonb_build_object('ok', false, 'error', 'pallet_not_found', 'message', 'no pallet with that id for this company');
  else
    select * into o from occupancy where pallet_id = p.id;
    if o.pallet_id is not null then select * into v_from from locations where id = o.location_id; end if;
    if p_kind = 'assign' and o.pallet_id is not null then r := jsonb_build_object('ok', false, 'error', 'pallet_elsewhere', 'message', 'that pallet already stands in a location; move it instead', 'location', v_from.code);
    elsif p_kind in ('move', 'release') and o.pallet_id is null then r := jsonb_build_object('ok', false, 'error', 'pallet_not_placed', 'message', 'that pallet is not in any location');
    elsif p_kind in ('move', 'release') and nullif(btrim(coalesce(p_expected_from, '')), '') is not null and upper(btrim(p_expected_from)) <> v_from.code then
      r := jsonb_build_object('ok', false, 'error', 'pallet_elsewhere', 'message', 'the pallet is not where the request says it is', 'location', v_from.code);
    elsif p_kind = 'release' then
      delete from occupancy where pallet_id = p.id; update pallets set status = 'released' where id = p.id;
      insert into change_log (warehouse, kind, company_id, location_id, pallet_id) values (w.code, 'pallet_released', p_company, v_from.id, p.id) returning seq into v_seq;
      r := jsonb_build_object('ok', true, 'pallet', v_ext, 'released_from', v_from.code, 'seq', v_seq);
    else
      select * into l from locations where warehouse = w.code and code = upper(btrim(coalesce(p_to, ''))) for update;   -- this lock is what makes capacity safe
      if l.id is null then r := jsonb_build_object('ok', false, 'error', 'location_not_found', 'message', 'no location with that code');
      elsif l.kind not in ('pallet', 'staging') or l.map_x is null or l.map_y is null then   -- in the registry, but not somewhere a pallet is stored (the dock)
        r := jsonb_build_object('ok', false, 'error', 'location_not_a_destination', 'message', 'that location is not a pallet storage position', 'location', l.code);
      elsif l.status = 'blocked' then r := jsonb_build_object('ok', false, 'error', 'location_blocked', 'message', coalesce(l.status_reason, 'that location is blocked'), 'location', l.code);
      elsif l.status = 'unavailable' then r := jsonb_build_object('ok', false, 'error', 'location_unavailable', 'message', coalesce(l.status_reason, 'that location is not in use'), 'location', l.code);
      elsif v_from.id = l.id then r := jsonb_build_object('ok', false, 'error', 'already_there', 'message', 'the pallet already stands there', 'location', l.code);
      else
        select count(*) into v_used from occupancy where location_id = l.id;
        if l.capacity is not null and v_used >= l.capacity then r := jsonb_build_object('ok', false, 'error', 'location_full', 'message', 'that location has no room', 'location', l.code, 'capacity', l.capacity, 'used', v_used);
        else
          insert into occupancy (pallet_id, location_id, placed_by) values (p.id, l.id, p_requester) on conflict (pallet_id) do update set location_id = excluded.location_id, since = now(), placed_by = excluded.placed_by;
          update pallets set status = 'active' where id = p.id and status <> 'active';
          insert into change_log (warehouse, kind, company_id, location_id, pallet_id) values (w.code, case when p_kind = 'assign' then 'pallet_assigned' else 'pallet_moved' end, p_company, l.id, p.id) returning seq into v_seq;
          r := jsonb_build_object('ok', true, 'pallet', v_ext, 'location', l.code, 'from', v_from.code, 'seq', v_seq, 'free', case when l.capacity is not null then l.capacity - v_used - 1 end);
        end if;
      end if;
    end if;
  end if;
  insert into moves (warehouse, kind, company_id, pallet_id, external_id, from_location, to_location, requester, idempotency_key, result, response, request, confirmation)
  values (w.code, p_kind, p_company, p.id, v_ext, v_from.id, l.id, p_requester, v_idem, case when (r ->> 'ok')::boolean then 'ok' else r ->> 'error' end, r, v_req, v_confirm);
  return r;
end $$;
-- The API's movement call with the confirmation fields. The earlier api_place stays for callers that do not send them.
create or replace function nexus.api_place_confirmed(p_key text, p_kind text, p_external_id text, p_to text, p_expected_from text, p_idem text, p_confirmed_empty text, p_confirmed_by text) returns jsonb
language plpgsql set search_path to 'nexus' as $$
begin
  perform set_config('nexus.confirm', jsonb_build_object('empty', lower(btrim(coalesce(p_confirmed_empty, ''))), 'by', coalesce(p_confirmed_by, ''))::text, true);
  return api_place(p_key, p_kind, p_external_id, p_to, p_expected_from, p_idem);
end $$;
-- Open a real floor in forward-only mode: blank, movements on, recorded. Refuses a floor that already holds anything.
create or replace function nexus.floor_open_forward_only(p_actor text, p_warehouse text, p_authority text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare w warehouses;
begin
  select * into w from warehouses where code = p_warehouse for update;
  if w.code is null or w.test then return jsonb_build_object('ok', false, 'error', 'bad_request', 'message', 'a real floor is required'); end if;
  if length(btrim(coalesce(p_authority, ''))) < 10 then return jsonb_build_object('ok', false, 'error', 'bad_request', 'message', 'state the owner decision this rests on'); end if;
  if w.occupancy_state <> 'not_initialized' or w.moves_enabled then return jsonb_build_object('ok', false, 'error', 'floor_not_ready', 'message', 'the floor must be uninitialized with movements off'); end if;
  if exists (select 1 from pallets where warehouse = w.code) or exists (select 1 from occupancy o join locations l on l.id = o.location_id where l.warehouse = w.code) then return jsonb_build_object('ok', false, 'error', 'floor_not_empty', 'message', 'a forward-only launch starts from zero recorded pallets'); end if;
  update warehouses set occupancy_state = 'forward_only', moves_enabled = true, last_unlocked_at = now() where code = w.code;
  insert into change_log (warehouse, kind) values (w.code, 'movements_enabled');
  insert into audit_log (actor, action, warehouse, after) values (p_actor, 'forward_only_opened', w.code, jsonb_build_object('authority', btrim(p_authority), 'rule', 'each placement needs a per-location empty confirmation'));
  return jsonb_build_object('ok', true, 'warehouse', w.code, 'occupancy_state', 'forward_only', 'moves_enabled', true);
end $$;
revoke all on function nexus.place(text, text, uuid, text, text, text, text, text, text) from public;
revoke all on function nexus.api_place_confirmed(text, text, text, text, text, text, text, text) from public;
revoke all on function nexus.floor_open_forward_only(text, text, text) from public;
