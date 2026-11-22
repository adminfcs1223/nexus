-- Undo 20261121_nexus_v2.sql. The label register and the floor log are dropped with it.
begin;
drop trigger if exists nexus_label_pallet on public.wms_pallets; drop trigger if exists nexus_label_carton on public.wms_cartons;
drop function if exists public.nexus_receiving_finish(uuid), public.nexus_receiving(uuid), public.nexus_receiving_brands(), public.nexus_api_labels(text, text), public.nexus_api_shipment_save(text, jsonb), public.nexus_api_shipments(text, date, date), public.nexus_api_scan(text, text, text), public.nexus_api_floor(text), public.nexus_api_window(text),
  public.nexus_connection_new_key(uuid, text), public.nexus_connection_save(uuid, text, uuid[], jsonb), public.nexus_connections_list(), public.nexus_shipment_update(uuid, date, integer, integer, text, text, boolean), public.nexus_dashboard(),
  public.nexus_positions_off(), public.nexus_position_edit(text, text, boolean), public.nexus_position_detail(text), public.nexus_pallet_detail(text), public.nexus_floor_log(integer), public.nexus_pallet_void(text, text),
  public.nexus_pallet_edit(text, jsonb, text), public.nexus_move_pallet(text, text, text, boolean), public.nexus_labels_printed(text, text[]), public.nexus_labels_list(uuid, text, text, integer), public._nexus_label_trg(), public._nexus_history(uuid, text, integer);
create or replace function public._nexus_api_client(p_key text) returns uuid[] language plpgsql security definer set search_path to 'public' as $$
declare n nexus_clients;
begin
  select * into n from nexus_clients where key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'utf8')), 'hex');
  if n.id is null or not n.active then raise exception 'Unknown or inactive Nexus key.'; end if;
  update nexus_clients set last_used_at = now() where id = n.id; return n.org_ids;
end $$;
drop function if exists public._nexus_api_auth(text), public._nexus_perms(jsonb), public._nexus_hash(text), public._nexus_newkey(), public._nexus_who();
alter table public.nexus_clients drop column if exists admin_key_hash, drop column if exists perms, drop column if exists admin_last_used_at;
drop table if exists public.nexus_labels, public.nexus_moves;
commit;
