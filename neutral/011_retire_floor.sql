-- Retire a test floor (owner decision, 2026-11-24): archive first, then take it out of use. Nothing is deleted.
-- After this the floor has movements off, every credential bound to it is deactivated (so no caller can select it), and a
-- full copy of its pallets, placements, movement history, feed and calendar sits in nexus.retired_floor_archive.
-- The real floor, its credentials and all shared API code are not touched.
create table if not exists nexus.retired_floor_archive (id bigserial primary key, warehouse text not null, archived_at timestamptz not null default now(), archived_by text not null, reason text not null, digest text not null, records jsonb not null);
alter table nexus.retired_floor_archive enable row level security;
revoke all on nexus.retired_floor_archive from public;
create or replace function nexus.floor_retire(p_actor text, p_warehouse text, p_reason text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare w warehouses; rec jsonb; d text; v_id bigint; v_keys integer;
begin
  select * into w from warehouses where code = p_warehouse for update;
  if w.code is null or not w.test then return jsonb_build_object('ok', false, 'error', 'bad_request', 'message', 'only a test floor can be retired this way'); end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then return jsonb_build_object('ok', false, 'error', 'bad_request', 'message', 'state the decision this rests on'); end if;
  rec := jsonb_build_object('warehouse', to_jsonb(w),
    'locations', (select coalesce(jsonb_agg(to_jsonb(l) order by l.code), '[]') from locations l where l.warehouse = w.code),
    'pallets', (select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('company', (select code from companies c where c.id = p.company_id)) order by p.external_id), '[]') from pallets p where p.warehouse = w.code),
    'occupancy', (select coalesce(jsonb_agg(to_jsonb(o) || jsonb_build_object('location', l.code, 'pallet', p.external_id, 'company', (select code from companies c where c.id = p.company_id)) order by l.code), '[]') from occupancy o join locations l on l.id = o.location_id join pallets p on p.id = o.pallet_id where l.warehouse = w.code),
    'moves', (select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]') from moves m where m.warehouse = w.code),
    'change_log', (select coalesce(jsonb_agg(to_jsonb(g) order by g.seq), '[]') from change_log g where g.warehouse = w.code),
    'calendar_events', (select coalesce(jsonb_agg(to_jsonb(e)), '[]') from calendar_events e where e.warehouse = w.code),
    'integrations', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'company', (select code from companies c where c.id = i.company_id), 'source_system', i.source_system, 'scopes', i.scopes, 'was_active', i.active, 'key_hash_prefix', left(i.key_hash, 8), 'last_ok_at', i.last_ok_at) order by i.source_system), '[]') from integrations i where i.warehouse = w.code));
  d := _hash(rec::text);
  insert into retired_floor_archive (warehouse, archived_by, reason, digest, records) values (w.code, p_actor, btrim(p_reason), d, rec) returning id into v_id;
  update integrations set active = false where warehouse = w.code and active; get diagnostics v_keys = row_count;
  update warehouses set moves_enabled = false, last_stopped_at = now() where code = w.code;
  insert into change_log (warehouse, kind) values (w.code, 'movements_stopped');
  insert into audit_log (actor, action, warehouse, target, after) values (p_actor, 'floor_retired', w.code, v_id::text, jsonb_build_object('reason', btrim(p_reason), 'archive', v_id, 'digest', d, 'credentials_deactivated', v_keys,
    'pallets', jsonb_array_length(rec -> 'pallets'), 'placements', jsonb_array_length(rec -> 'occupancy'), 'moves', jsonb_array_length(rec -> 'moves')));
  return jsonb_build_object('ok', true, 'warehouse', w.code, 'archive', v_id, 'digest', d, 'credentials_deactivated', v_keys, 'pallets', jsonb_array_length(rec -> 'pallets'), 'placements', jsonb_array_length(rec -> 'occupancy'), 'moves', jsonb_array_length(rec -> 'moves'), 'feed', jsonb_array_length(rec -> 'change_log'));
end $$;
revoke all on function nexus.floor_retire(text, text, text) from public;
