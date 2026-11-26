-- What the Nexus website shows (2026-11-25): one read of the same map, occupancy and calendar records both WMSs use.
-- No second registry: this only reads nexus.locations / occupancy / pallets / calendar_events. The site belongs to neither
-- company, so it shows which company stands where and when, and never a pallet id, a reference or a note.
create or replace function nexus.site_overview(p_warehouse text) returns jsonb language sql stable set search_path to 'nexus' as $$
  select case when w.code is null then jsonb_build_object('ok', false, 'error', 'not_found', 'message', 'no such floor') else jsonb_build_object('ok', true, 'as_of', now(),
    'warehouse', w.code, 'name', w.name, 'map_version', w.map_version, 'checksum', _map_checksum(w.code), 'occupancy_state', w.occupancy_state, 'moves_enabled', w.moves_enabled,
    'layout', w.layout, 'landmarks', w.landmarks, 'last_seq', (select coalesce(max(seq), 0) from change_log g where g.warehouse = w.code),
    'positions', (select coalesce(jsonb_agg(jsonb_build_object('code', l.code, 'kind', l.kind, 'block', l.map_block, 'x', l.map_x, 'y', l.map_y, 'status', l.status, 'status_reason', l.status_reason, 'capacity', l.capacity,
        'used', (select count(*) from occupancy o where o.location_id = l.id),
        'occupants', (select coalesce(jsonb_agg(jsonb_build_object('company', x.code, 'name', x.name, 'pallets', x.n, 'since', x.since) order by x.code), '[]') from (select c.code, c.name, count(*) n, min(o.since) since from occupancy o join pallets p on p.id = o.pallet_id join companies c on c.id = p.company_id where o.location_id = l.id group by c.code, c.name) x))
      order by l.code), '[]') from locations l where l.warehouse = w.code),
    'pallets', (select coalesce(jsonb_agg(jsonb_build_object('location', l.code, 'kind', l.kind, 'company', c.code, 'company_name', c.name, 'since', o.since) order by l.code, o.since), '[]') from occupancy o join locations l on l.id = o.location_id join pallets p on p.id = o.pallet_id join companies c on c.id = p.company_id where l.warehouse = w.code),
    'calendar', (select coalesce(jsonb_agg(jsonb_build_object('company', c.code, 'company_name', c.name, 'direction', e.direction, 'starts_at', e.starts_at, 'ends_at', e.ends_at, 'pallets', e.pallets, 'status', e.status) order by e.starts_at), '[]')
      from calendar_events e join companies c on c.id = e.company_id where e.warehouse = w.code and e.starts_at >= now() - interval '31 days' and e.starts_at < now() + interval '120 days'))
  end from (select 1) one left join warehouses w on w.code = p_warehouse and not w.test
$$;
revoke all on function nexus.site_overview(text) from public;
