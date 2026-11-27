-- Stage 2, task 1 (owner approval 2026-11-27): the shared RECEIVING / OUTBOUND zone on HILLSBOROUGH. Loaded after 013.
-- One new location, RCV-OUT, kind `zone`: upper left of the floor, under the Exit, above the left-hand rows, left of the dock.
-- It is drawn at the footprint of six pallet positions (2 wide, 3 deep) as a size reference only; it has no pallet limit.
-- Both companies stand pallets there at the same time. Each pallet keeps its own identity and history, and carries a status,
-- inbound or outbound, given when it enters. It is the same occupancy table and the same movement engine as every other
-- position: no second registry. P-01..P-66, STG-01, STG-02 and RCV-DOCK are not touched, and their rules do not change.
-- To switch the zone off without removing anything: select nexus.location_set(...) / set its status to 'unavailable'.
alter table nexus.locations drop constraint locations_kind_check, add constraint locations_kind_check check (kind in ('pallet', 'staging', 'dock', 'zone'));
alter table nexus.occupancy add column if not exists flow text check (flow in ('inbound', 'outbound'));

insert into nexus.locations (code, kind, warehouse, zone, map_block, map_col, map_row, capacity, capacity_spec, updated_by)
select 'RCV-OUT', 'zone', w.code, 'receiving_outbound', 'receiving_outbound', 1, 1, null,
  'Shared receiving / outbound zone. Drawn at the footprint of six pallet positions for size reference only; no pallet limit (owner, Stage 2, 2026-11-27).', 'claude:stage2-zone'
from nexus.warehouses w where w.code = 'HILLSBOROUGH' and not exists (select 1 from nexus.locations l where l.warehouse = w.code and l.code = 'RCV-OUT');
-- where it is drawn: three rows above row 1 (y = -2, -1, 0), over the two left-hand columns. Existing coordinates do not move.
update nexus.warehouses set map_version = 5,
  layout = jsonb_set(layout, '{grid,top_rows}', '3') || jsonb_build_object('blocks', (layout -> 'blocks') || jsonb_build_array(jsonb_build_object(
    'key', 'receiving_outbound', 'label', 'Receiving / Outbound', 'side', 'left', 'x', jsonb_build_array(1, 2), 'y', jsonb_build_array(-2, 0), 'location', 'RCV-OUT', 'shared', true, 'footprint', 'visual only, not a capacity')))
where code = 'HILLSBOROUGH' and map_version = 4 and not (layout -> 'blocks') @> '[{"key": "receiving_outbound"}]';
insert into nexus.change_log (warehouse, kind) select 'HILLSBOROUGH', 'map_changed' where exists (select 1 from nexus.warehouses where code = 'HILLSBOROUGH' and map_version = 5)
  and not exists (select 1 from nexus.audit_log where action = 'shared_zone_added' and warehouse = 'HILLSBOROUGH');
insert into nexus.audit_log (actor, action, warehouse, target, after) select 'claude:stage2-zone', 'shared_zone_added', 'HILLSBOROUGH', 'RCV-OUT', jsonb_build_object('map_version', 5, 'authority', 'owner approval, Souled Stage 2 Receiving Draft V2, 2026-11-27')
where exists (select 1 from nexus.warehouses where code = 'HILLSBOROUGH' and map_version = 5) and not exists (select 1 from nexus.audit_log where action = 'shared_zone_added' and warehouse = 'HILLSBOROUGH');

create or replace function nexus.place(p_requester text, p_warehouse text, p_company uuid, p_source text, p_kind text, p_external_id text, p_to text, p_expected_from text, p_idem text) returns jsonb
language plpgsql set search_path to 'nexus' as $$
declare v_ext text := btrim(coalesce(p_external_id, '')); v_idem text := btrim(coalesce(p_idem, '')); w warehouses; m moves; p pallets; l locations; o occupancy; v_from locations; v_used int; r jsonb; v_seq bigint;
  v_to text := nullif(upper(btrim(coalesce(p_to, ''))), ''); v_exp text := nullif(upper(btrim(coalesce(p_expected_from, ''))), ''); v_req jsonb; v_confirm jsonb; v_tokind text; v_zs text;
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
  -- what the caller sent alongside the request (api_place_confirmed / api_place_zone put it here)
  begin v_confirm := nullif(current_setting('nexus.confirm', true), '')::jsonb; exception when others then v_confirm := null; end;
  select kind into v_tokind from locations where warehouse = w.code and code = v_to;
  if p_kind in ('assign', 'move') and v_tokind = 'zone' then
    -- the shared zone: several pallets of both companies stand there at once, so "confirmed empty" does not apply.
    -- Each pallet entering says whether it is inbound or outbound; without that nothing is recorded and the same key can be sent again.
    v_zs := lower(btrim(coalesce(v_confirm ->> 'zone_status', '')));
    if v_zs not in ('inbound', 'outbound') then
      return jsonb_build_object('ok', false, 'error', 'zone_status_required', 'location', v_to, 'message', 'A pallet entering the shared zone needs zone_status: "inbound" or "outbound".');
    end if;
    v_req := v_req || jsonb_build_object('zone_status', v_zs);
    v_confirm := jsonb_build_object('zone_status', v_zs, 'location', v_to, 'at', now())
      || case when length(btrim(coalesce(v_confirm ->> 'by', ''))) between 2 and 80 then jsonb_build_object('by', btrim(v_confirm ->> 'by')) else '{}'::jsonb end;
  elsif w.occupancy_state = 'forward_only' and p_kind in ('assign', 'move') then
    -- forward-only floor: a pallet goes into a position only after a person on the floor has confirmed it is physically empty.
    if coalesce(v_confirm ->> 'empty', '') <> 'true' or length(btrim(coalesce(v_confirm ->> 'by', ''))) not between 2 and 80 then
      return jsonb_build_object('ok', false, 'error', 'location_not_confirmed', 'message', 'Confirm on the floor that the destination is physically empty, then send confirmed_empty: true and confirmed_by: <who checked>.');
    end if;
    v_confirm := jsonb_build_object('empty', true, 'by', btrim(v_confirm ->> 'by'), 'location', v_to, 'at', now());
  else v_confirm := null;
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
      elsif not (l.kind = 'zone' or (l.kind in ('pallet', 'staging') and l.map_x is not null and l.map_y is not null)) then   -- in the registry, but not somewhere a pallet is stored (the dock)
        r := jsonb_build_object('ok', false, 'error', 'location_not_a_destination', 'message', 'that location is not a pallet storage position', 'location', l.code);
      elsif l.status = 'blocked' then r := jsonb_build_object('ok', false, 'error', 'location_blocked', 'message', coalesce(l.status_reason, 'that location is blocked'), 'location', l.code);
      elsif l.status = 'unavailable' then r := jsonb_build_object('ok', false, 'error', 'location_unavailable', 'message', coalesce(l.status_reason, 'that location is not in use'), 'location', l.code);
      elsif v_from.id = l.id and l.kind = 'zone' and o.flow is distinct from v_zs then   -- same zone, the pallet's status changes (inbound <-> outbound)
        update occupancy set flow = v_zs where pallet_id = p.id;
        insert into change_log (warehouse, kind, company_id, location_id, pallet_id) values (w.code, 'pallet_moved', p_company, l.id, p.id) returning seq into v_seq;
        r := jsonb_build_object('ok', true, 'pallet', v_ext, 'location', l.code, 'from', v_from.code, 'seq', v_seq, 'free', null, 'zone_status', v_zs, 'status_changed', true);
      elsif v_from.id = l.id then r := jsonb_build_object('ok', false, 'error', 'already_there', 'message', 'the pallet already stands there', 'location', l.code);
      else
        select count(*) into v_used from occupancy where location_id = l.id;
        if l.capacity is not null and v_used >= l.capacity then r := jsonb_build_object('ok', false, 'error', 'location_full', 'message', 'that location has no room', 'location', l.code, 'capacity', l.capacity, 'used', v_used);
        else
          insert into occupancy (pallet_id, location_id, placed_by, flow) values (p.id, l.id, p_requester, case when l.kind = 'zone' then v_zs end) on conflict (pallet_id) do update set location_id = excluded.location_id, since = now(), placed_by = excluded.placed_by, flow = excluded.flow;
          update pallets set status = 'active' where id = p.id and status <> 'active';
          insert into change_log (warehouse, kind, company_id, location_id, pallet_id) values (w.code, case when p_kind = 'assign' then 'pallet_assigned' else 'pallet_moved' end, p_company, l.id, p.id) returning seq into v_seq;
          r := jsonb_build_object('ok', true, 'pallet', v_ext, 'location', l.code, 'from', v_from.code, 'seq', v_seq, 'free', case when l.capacity is not null then l.capacity - v_used - 1 end) || case when l.kind = 'zone' then jsonb_build_object('zone_status', v_zs) else '{}'::jsonb end;
        end if;
      end if;
    end if;
  end if;
  insert into moves (warehouse, kind, company_id, pallet_id, external_id, from_location, to_location, requester, idempotency_key, result, response, request, confirmation)
  values (w.code, p_kind, p_company, p.id, v_ext, v_from.id, l.id, p_requester, v_idem, case when (r ->> 'ok')::boolean then 'ok' else r ->> 'error' end, r, v_req, v_confirm);
  return r;
end $$;

create or replace function nexus._occupancy_guard() returns trigger language plpgsql set search_path to 'nexus' as $$
declare l locations;
begin
  if tg_op = 'UPDATE' and new.location_id = old.location_id then return new; end if;
  select * into l from locations where id = new.location_id;
  if not (l.kind = 'zone' or (l.kind in ('pallet', 'staging') and l.map_x is not null and l.map_y is not null)) then raise exception '% is not a pallet storage position', l.code using errcode = 'check_violation'; end if;
  if l.kind = 'zone' and new.flow is null then raise exception 'a pallet in % needs an inbound or outbound status', l.code using errcode = 'check_violation'; end if;
  if l.kind <> 'zone' then new.flow := null; end if;
  return new;
end $$;

-- The API's movement call when the body carries zone_status. The two earlier calls stay as they are.
create or replace function nexus.api_place_zone(p_key text, p_kind text, p_external_id text, p_to text, p_expected_from text, p_idem text, p_confirmed_empty text, p_confirmed_by text, p_zone_status text) returns jsonb
language plpgsql set search_path to 'nexus' as $$
begin
  perform set_config('nexus.confirm', jsonb_build_object('empty', lower(btrim(coalesce(p_confirmed_empty, ''))), 'by', coalesce(p_confirmed_by, ''), 'zone_status', coalesce(p_zone_status, ''))::text, true);
  return api_place(p_key, p_kind, p_external_id, p_to, p_expected_from, p_idem);
end $$;

-- Occupancy: every existing location answers exactly as before. The zone adds, per company, how many pallets are inbound and
-- outbound, and for the caller's own pallets their status. The other company's pallet ids are never shown.
create or replace function nexus.api_occupancy(p_key text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; w warehouses;
begin
  select * into a from _auth(p_key, 'read'); if a.error is not null then return a.error; end if;
  select * into w from warehouses where code = a.warehouse;
  return jsonb_build_object('ok', true, 'as_of', now(), 'warehouse', w.code, 'test', w.test, 'occupancy_state', w.occupancy_state, 'moves_enabled', w.moves_enabled, 'locations', (select coalesce(jsonb_agg(jsonb_build_object('code', l.code, 'kind', l.kind, 'zone', l.zone, 'status', l.status, 'capacity', l.capacity,
      'used', (select count(*) from occupancy o where o.location_id = l.id), 'free', case when l.capacity is not null then l.capacity - (select count(*) from occupancy o where o.location_id = l.id) end,
      'occupants', (select coalesce(jsonb_agg(jsonb_build_object('company', c.code, 'pallets', x.n) || case when l.kind = 'zone' then jsonb_build_object('inbound', x.n_in, 'outbound', x.n_out) else '{}'::jsonb end order by c.code), '[]')
        from (select p.company_id, count(*) n, count(*) filter (where o.flow = 'inbound') n_in, count(*) filter (where o.flow = 'outbound') n_out from occupancy o join pallets p on p.id = o.pallet_id where o.location_id = l.id group by 1) x join companies c on c.id = x.company_id),
      'your_pallets', (select coalesce(jsonb_agg(p.external_id order by o.since), '[]') from occupancy o join pallets p on p.id = o.pallet_id where o.location_id = l.id and p.company_id = a.company_id),
      'updated_at', greatest(l.updated_at, (select max(o.since) from occupancy o where o.location_id = l.id)))
      || case when l.kind = 'zone' then jsonb_build_object('shared', true,
        'your_pallets_status', (select coalesce(jsonb_agg(jsonb_build_object('pallet', p.external_id, 'zone_status', o.flow, 'since', o.since) order by o.since), '[]') from occupancy o join pallets p on p.id = o.pallet_id where o.location_id = l.id and p.company_id = a.company_id)) else '{}'::jsonb end
      order by l.code), '[]') from locations l where l.warehouse = a.warehouse));
end $$;

create or replace function nexus.api_moves(p_key text, p_external_id text default null, p_before bigint default null, p_limit integer default 200) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record;
begin
  select * into a from _auth(p_key, 'read'); if a.error is not null then return a.error; end if;
  return jsonb_build_object('ok', true, 'moves', (select coalesce(jsonb_agg(x.j order by x.id desc), '[]') from (
    select m.id, jsonb_build_object('id', m.id, 'at', m.at, 'kind', m.kind, 'pallet', m.external_id, 'from', f.code, 'to', t.code, 'result', m.result)
      || case when m.confirmation ? 'zone_status' then jsonb_build_object('zone_status', m.confirmation ->> 'zone_status') else '{}'::jsonb end j
    from moves m left join locations f on f.id = m.from_location left join locations t on t.id = m.to_location
    where m.warehouse = a.warehouse and m.company_id = a.company_id and (p_external_id is null or m.external_id = btrim(p_external_id)) and (p_before is null or m.id < p_before)
    order by m.id desc limit least(greatest(coalesce(p_limit, 200), 1), 1000)) x));
end $$;

-- The website's view: the zone's occupants carry inbound / outbound counts, and a registry row in the zone carries its status.
create or replace function nexus.site_overview(p_warehouse text) returns jsonb language sql stable set search_path to 'nexus' as $$
  select case when w.code is null then jsonb_build_object('ok', false, 'error', 'not_found', 'message', 'no such floor') else jsonb_build_object('ok', true, 'as_of', now(),
    'warehouse', w.code, 'name', w.name, 'map_version', w.map_version, 'checksum', _map_checksum(w.code), 'occupancy_state', w.occupancy_state, 'moves_enabled', w.moves_enabled,
    'layout', w.layout, 'landmarks', w.landmarks, 'last_seq', (select coalesce(max(seq), 0) from change_log g where g.warehouse = w.code),
    'positions', (select coalesce(jsonb_agg(jsonb_build_object('code', l.code, 'kind', l.kind, 'block', l.map_block, 'x', l.map_x, 'y', l.map_y, 'status', l.status, 'status_reason', l.status_reason, 'capacity', l.capacity,
        'used', (select count(*) from occupancy o where o.location_id = l.id),
        'occupants', (select coalesce(jsonb_agg(jsonb_build_object('company', x.code, 'name', x.name, 'pallets', x.n, 'since', x.since) || case when l.kind = 'zone' then jsonb_build_object('inbound', x.n_in, 'outbound', x.n_out) else '{}'::jsonb end order by x.code), '[]') from (select c.code, c.name, count(*) n, min(o.since) since, count(*) filter (where o.flow = 'inbound') n_in, count(*) filter (where o.flow = 'outbound') n_out from occupancy o join pallets p on p.id = o.pallet_id join companies c on c.id = p.company_id where o.location_id = l.id group by c.code, c.name) x))
      order by l.code), '[]') from locations l where l.warehouse = w.code),
    'pallets', (select coalesce(jsonb_agg(jsonb_build_object('location', l.code, 'kind', l.kind, 'company', c.code, 'company_name', c.name, 'since', o.since, 'zone_status', o.flow) order by l.code, o.since), '[]') from occupancy o join locations l on l.id = o.location_id join pallets p on p.id = o.pallet_id join companies c on c.id = p.company_id where l.warehouse = w.code),
    'calendar', (select coalesce(jsonb_agg(jsonb_build_object('company', c.code, 'company_name', c.name, 'direction', e.direction, 'starts_at', e.starts_at, 'ends_at', e.ends_at, 'pallets', e.pallets, 'status', e.status) order by e.starts_at), '[]')
      from calendar_events e join companies c on c.id = e.company_id where e.warehouse = w.code and e.starts_at >= now() - interval '31 days' and e.starts_at < now() + interval '120 days'))
  end from (select 1) one left join warehouses w on w.code = p_warehouse and not w.test
$$;
revoke all on function nexus.site_overview(text) from public;
revoke all on function nexus.place(text, text, uuid, text, text, text, text, text, text) from public;
revoke all on function nexus._occupancy_guard() from public;
revoke all on function nexus.api_place_zone(text, text, text, text, text, text, text, text, text) from public;
revoke all on function nexus.api_occupancy(text) from public;
revoke all on function nexus.api_moves(text, text, bigint, integer) from public;
