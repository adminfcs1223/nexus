-- ROLLBACK for 010_forward_only.sql. Closes any forward-only floor (movements off; recorded pallets and history are kept),
-- puts the engine back to the 007 text and removes the two added functions. The widened constraints and the
-- moves.confirmation column stay: both are harmless once no floor is in forward-only mode with movements on.
update nexus.warehouses set moves_enabled = false, last_stopped_at = now() where occupancy_state = 'forward_only' and moves_enabled;
insert into nexus.change_log (warehouse, kind) select code, 'movements_stopped' from nexus.warehouses where occupancy_state = 'forward_only';
insert into nexus.audit_log (actor, action, warehouse, after) select 'rollback-010', 'movements_stopped', code, '{"reason": "010 rolled back"}' from nexus.warehouses where occupancy_state = 'forward_only';
create or replace function nexus.place(p_requester text, p_warehouse text, p_company uuid, p_source text, p_kind text, p_external_id text, p_to text, p_expected_from text, p_idem text) returns jsonb
language plpgsql set search_path to 'nexus' as $$
declare v_ext text := btrim(coalesce(p_external_id, '')); v_idem text := btrim(coalesce(p_idem, '')); w warehouses; m moves; p pallets; l locations; o occupancy; v_from locations; v_used int; r jsonb; v_seq bigint;
  v_to text := nullif(upper(btrim(coalesce(p_to, ''))), ''); v_exp text := nullif(upper(btrim(coalesce(p_expected_from, ''))), ''); v_req jsonb;
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
  insert into moves (warehouse, kind, company_id, pallet_id, external_id, from_location, to_location, requester, idempotency_key, result, response, request)
  values (w.code, p_kind, p_company, p.id, v_ext, v_from.id, l.id, p_requester, v_idem, case when (r ->> 'ok')::boolean then 'ok' else r ->> 'error' end, r, v_req);
  return r;
end $$;
drop function if exists nexus.api_place_confirmed(text, text, text, text, text, text, text, text);
drop function if exists nexus.floor_open_forward_only(text, text, text);
revoke all on function nexus.place(text, text, uuid, text, text, text, text, text, text) from public;
