-- The ShipBay WMS receiving functions Nexus calls, exactly as they are in production (definitions read 2026-11-21), plus the
-- three inbound_shipments / wms_pallets triggers that bear on receiving. Loaded into the local database so the tests run the
-- real receiving code, not a stand-in.
create function public.is_wms_staff() returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from profiles where id = auth.uid() and active is not false and role in ('shipbay_admin','shipbay_staff','wms_employee')); $$;
create function public._is_shipbay_staff() returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from profiles where id = auth.uid() and role in ('shipbay_admin', 'shipbay_staff') and active is not false) $$;
create function public._active_caller(out uid uuid, out role text, out org_id uuid, out staff boolean) returns record language sql stable security definer set search_path to 'public' as $$
  select p.id, p.role, p.org_id, p.role in ('shipbay_admin', 'shipbay_staff', 'shipbay_sales', 'wms_employee') from profiles p where p.id = auth.uid() and p.active; $$;
create function public.wms_products(p_org uuid) returns table(id uuid, sku text, name text, asins text[], supplier text, barcode text, expected_qty integer, expected_fba integer, expected_fbm integer)
language sql stable security definer set search_path to 'public' as $$
  select s.id, s.sku, s.name, s.asins, s.supplier, s.barcode, s.expected_qty, s.expected_fba, s.expected_fbm from skus s where is_wms_staff() and s.org_id = p_org and s.active order by s.name; $$;
create function public._wms_pick_location(p_pallet uuid) returns uuid language plpgsql security definer set search_path to 'public' as $$
declare v_org uuid; v_loc uuid;
begin
  select org_id into v_org from wms_pallets where id = p_pallet;
  select l.id into v_loc from locations l
  where l.active and l.kind = 'pallet' and not exists (select 1 from wms_pallets p where p.location_id = l.id and p.status in ('counted', 'stored'))
  order by (exists (select 1 from wms_pallets p join locations l2 on l2.id = p.location_id where p.org_id = v_org and p.status in ('counted', 'stored') and l2.zone is not distinct from l.zone)) desc, l.code
  limit 1;
  update wms_pallets set location_id = v_loc where id = p_pallet;
  return v_loc;
end $$;
create function public.wms_hold_pskus(p_key text, p_pallets integer default 1) returns setof text language plpgsql security definer set search_path to 'public' as $$
declare v_n int := coalesce(p_pallets, 1); v_key text := nullif(trim(p_key), ''); i int;
begin
  if not is_wms_staff() then raise exception 'This login cannot receive pallets.'; end if;
  if v_key is null then raise exception 'No form key.'; end if;
  if v_n < 1 or v_n > 60 then raise exception 'Receive between 1 and 60 pallets at a time.'; end if;
  if exists (select 1 from wms_pallets where batch_key = v_key) then return query select psku from wms_pallets where batch_key = v_key order by batch_pos; return; end if;
  for i in 1..v_n loop
    if not exists (select 1 from wms_psku_holds where batch_key = v_key and pos = i) then
      insert into wms_psku_holds (batch_key, pos, num, held_by) values (v_key, i, lpad(nextval('wms_psku_seq')::text, 6, '0'), auth.uid());
    end if;
  end loop;
  return query select 'PSKU-' || h.num from wms_psku_holds h where h.batch_key = v_key and h.pos <= v_n order by h.pos;
end $$;
create function public.wms_receive(p_org uuid, p_lines jsonb, p_pallets integer default 1, p_notes text default null, p_key text default null) returns setof wms_pallets
language plpgsql security definer set search_path to 'public' as $$
declare
  v_n int := coalesce(p_pallets, 1);
  v_key text := coalesce(nullif(trim(p_key), ''), gen_random_uuid()::text);
  v_who text; v_lines int; v_total int := 0; v_mixed boolean; v_allfba boolean := true;
  l jsonb; s skus; i int; g int; v_id uuid; v_num text; v_w int; v_seq int; v_c int; v_upc int; v_name text; v_fba boolean; v_cle boolean; v_allcle boolean := true; v_log int := 0;
begin
  if not is_wms_staff() then raise exception 'This login cannot receive pallets.'; end if;
  if v_n < 1 or v_n > 60 then raise exception 'Receive between 1 and 60 pallets at a time.'; end if;
  if not exists (select 1 from orgs where id = p_org) then raise exception 'Pick a brand first.'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1 then raise exception 'Pick the product.'; end if;
  v_lines := jsonb_array_length(p_lines);
  if v_lines > 20 then raise exception 'A pallet takes up to 20 products here.'; end if;
  v_mixed := v_lines > 1;
  for l in select * from jsonb_array_elements(p_lines) loop
    v_cle := coalesce((l->>'cle')::boolean, false);
    v_c := case when v_cle then 1 else coalesce(nullif(l->>'cartons', '')::int, 0) end;
    if v_c < 0 or v_c > 500 then raise exception 'A line holds between 0 and 500 cartons.'; end if;
    if v_mixed and v_c < 1 then raise exception 'On a mixed pallet every product needs its carton count.'; end if;
    if nullif(l->>'units_per_carton', '') is not null and (l->>'units_per_carton')::int < 1 then raise exception 'Units per carton starts at 1.'; end if;
    if not v_cle and v_c > 0 and nullif(l->>'units_per_carton', '') is null then raise exception 'Units per carton is needed: it is what puts the stock on the shelf.'; end if;
    if nullif(l->>'sku', '') is not null then
      if not exists (select 1 from skus where id = (l->>'sku')::uuid and org_id = p_org) then raise exception 'One of those products is not on this brand''s list.'; end if;
    elsif coalesce(trim(l->>'name'), '') = '' then raise exception 'Pick the product, or say what it is.';
    end if;
    v_total := v_total + v_c;
    v_allfba := v_allfba and coalesce((l->>'fba')::boolean, false);
    v_allcle := v_allcle and v_cle;
    if not v_cle then v_log := v_log + v_c; end if;
  end loop;
  if v_total > 500 then raise exception 'A pallet holds up to 500 cartons here.'; end if;
  if exists (select 1 from wms_pallets where batch_key = v_key) then
    return query select * from wms_pallets where batch_key = v_key order by batch_pos; return;
  end if;
  select coalesce(full_name, email) into v_who from profiles where id = auth.uid();
  v_w := greatest(2, length(v_total::text));
  for i in 1..v_n loop
    select num into v_num from wms_psku_holds where batch_key = v_key and pos = i;
    if v_num is null then v_num := lpad(nextval('wms_psku_seq')::text, 6, '0'); end if;
    l := p_lines->0; s := null;
    if not v_mixed and nullif(l->>'sku', '') is not null then select * into s from skus where id = (l->>'sku')::uuid; end if;
    insert into wms_pallets (psku, org_id, status, mixed, fba, cle, sku_id, item_no, item_name, cartons, units_per_carton, notes, batch_key, batch_pos, batch_size, client_key,
                             received_by, received_by_name, counted_at, counted_by_name)
    values ('PSKU-' || v_num, p_org, case when v_log > 0 then 'open' else 'counted' end, v_mixed, v_allfba, v_allcle,
            case when v_mixed then null else s.id end, case when v_mixed then null else s.sku end,
            case when v_mixed then 'Mixed pallet · ' || v_lines || ' products' else coalesce(s.name, left(trim(l->>'name'), 300)) end,
            nullif(v_log, 0), case when v_mixed or v_cle then null else nullif(l->>'units_per_carton', '')::int end, nullif(trim(p_notes), ''),
            v_key, i, v_n, v_key || ':' || i, auth.uid(), v_who,
            case when v_log > 0 then null else now() end, case when v_log > 0 then null else v_who end)
    returning id into v_id;
    v_seq := 0;
    for l in select * from jsonb_array_elements(p_lines) loop
      s := null;
      if nullif(l->>'sku', '') is not null then select * into s from skus where id = (l->>'sku')::uuid; end if;
      v_cle := coalesce((l->>'cle')::boolean, false);
      v_c := case when v_cle then 1 else coalesce(nullif(l->>'cartons', '')::int, 0) end; v_upc := nullif(l->>'units_per_carton', '')::int;
      v_name := coalesce(s.name, left(trim(l->>'name'), 300)); v_fba := coalesce((l->>'fba')::boolean, false);
      for g in 1..v_c loop
        v_seq := v_seq + 1;
        insert into wms_cartons (pallet_id, org_id, seq, code, sku_id, item_no, item_name, units_per_carton, fba, cle, scanned_at, scanned_by_name)
        values (v_id, p_org, v_seq, 'C' || v_num || lpad(v_seq::text, v_w, '0'), s.id, s.sku, v_name, v_upc, v_fba, v_cle, case when v_cle then now() end, case when v_cle then 'NCC' end);
      end loop;
    end loop;
    if v_log = 0 then perform _wms_pick_location(v_id); end if;
  end loop;
  return query select * from wms_pallets where batch_key = v_key order by batch_pos;
end $$;
create function public.wms_receive_booking(p_inbound uuid, p_org uuid, p_lines jsonb, p_pallets integer, p_notes text, p_key text, p_mode text, p_hold_reason text) returns setof wms_pallets
language plpgsql security definer set search_path to 'public' as $$
declare
  b inbound_shipments; v_key text := nullif(trim(p_key), ''); v_mode text := coalesce(p_mode, 'partial'); v_sig text;
  lk wms_receipt_links; v_n int := coalesce(p_pallets, 1); v_log int := 0; l jsonb; v_c int; v_cle boolean;
  v_rp int; v_rc int; v_dp int; v_dc int; v_who text;
begin
  if not is_wms_staff() or (select uid from _active_caller()) is null then raise exception 'This login cannot receive pallets.'; end if;
  if v_key is null then raise exception 'A booked receipt needs its request key.'; end if;
  if v_mode not in ('partial', 'hold', 'final') then raise exception 'Say whether more is coming, it is on HOLD, or this is the last of the booking.'; end if;
  if v_mode = 'hold' and coalesce(trim(p_hold_reason), '') = '' then raise exception 'Say why it is on HOLD.'; end if;
  v_sig := md5(jsonb_build_object('inbound', p_inbound, 'org', p_org, 'lines', p_lines, 'pallets', v_n, 'notes', nullif(trim(p_notes), ''),
                                  'mode', v_mode, 'hold', nullif(trim(p_hold_reason), ''))::text);
  select * into b from inbound_shipments where id = p_inbound for update;
  if not found then raise exception 'That booking is not on file.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('wms_receive:' || v_key, 0));
  select * into lk from wms_receipt_links where batch_key = v_key;
  if found then
    if lk.inbound_id <> p_inbound or lk.request_sig <> v_sig then raise exception 'This request key was already used for a different receipt. Nothing was received.'; end if;
    return query select * from wms_pallets where batch_key = v_key order by batch_pos; return;
  end if;
  if exists (select 1 from wms_pallets where batch_key = v_key) then raise exception 'This request key was already used for an unbooked receipt. Nothing was received.'; end if;
  if b.org_id <> p_org then raise exception 'That booking belongs to another brand. Nothing was received.'; end if;
  if b.approved_at is null then raise exception 'That booking has not been approved yet.'; end if;
  if b.status not in ('expected', 'in_transit') then raise exception 'That booking is %: it cannot take more pallets.', b.status; end if;
  if exists (select 1 from wms_receipt_links where inbound_id = b.id and mode = 'final') then raise exception 'That booking was closed by its last receipt: it cannot take more pallets.'; end if;
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_cle := coalesce((l->>'cle')::boolean, false);
    v_c := case when v_cle then 1 else coalesce(nullif(l->>'cartons', '')::int, 0) end;
    if not v_cle then v_log := v_log + v_c; end if;
  end loop;
  perform 1 from wms_receive(b.org_id, p_lines, v_n, p_notes, v_key);
  update wms_pallets set inbound_id = b.id, held = (v_mode = 'hold'), hold_reason = case when v_mode = 'hold' then trim(p_hold_reason) end where batch_key = v_key and org_id = b.org_id;
  if v_mode = 'final' then
    select coalesce(sum(pallets), 0) + v_n, coalesce(sum(cartons), 0) + v_log * v_n into v_rp, v_rc from wms_receipt_links where inbound_id = b.id;
    v_dp := case when b.pallets > 0 then b.pallets - v_rp end; v_dc := case when b.cartons > 0 then b.cartons - v_rc end;
  end if;
  select coalesce(full_name, email) into v_who from profiles where id = auth.uid();
  insert into wms_receipt_links (inbound_id, org_id, batch_key, request_sig, mode, pallets, cartons, hold_reason, diff_pallets, diff_cartons, received_by, received_by_name)
  values (b.id, b.org_id, v_key, v_sig, v_mode, v_n, v_log * v_n, nullif(trim(p_hold_reason), ''), v_dp, v_dc, auth.uid(), v_who);
  return query select * from wms_pallets where batch_key = v_key order by batch_pos;
end $$;
grant execute on function public.wms_products(uuid), public.wms_hold_pskus(text, integer), public.wms_receive_booking(uuid, uuid, jsonb, integer, text, text, text, text) to authenticated;
-- triggers
create function public._inbound_approval_guard() returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    if _is_shipbay_staff() then
      new.approved_at := coalesce(new.approved_at, now()); new.approved_by := coalesce(new.approved_by, auth.uid());
      new.approved_by_name := coalesce(new.approved_by_name, (select coalesce(full_name, email) from profiles where id = auth.uid()));
    else new.approved_at := null; new.approved_by := null; new.approved_by_name := null; end if;
  elsif not _is_shipbay_staff() then
    new.approved_at := old.approved_at; new.approved_by := old.approved_by; new.approved_by_name := old.approved_by_name;
  end if;
  return new;
end $$;
create trigger inbound_approval_guard before insert or update on inbound_shipments for each row execute function _inbound_approval_guard();
create function public.log_status_event() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare ent text := tg_argv[0];
begin
  if tg_op = 'INSERT' then insert into events (org_id, entity, entity_id, action, to_value, actor_id) values (new.org_id, ent, new.id, 'created', new.status, auth.uid());
  elsif new.status is distinct from old.status then insert into events (org_id, entity, entity_id, action, from_value, to_value, actor_id) values (new.org_id, ent, new.id, 'status_change', old.status, new.status, auth.uid()); end if;
  return new;
end $$;
create trigger inbound_events after insert or update on inbound_shipments for each row execute function log_status_event('inbound');
create function public._wms_hold_gate() returns trigger language plpgsql set search_path to 'public' as $$
begin
  if new.held and new.status = 'stored' and (tg_op = 'INSERT' or old.status is distinct from 'stored') then
    raise exception '% is on HOLD (%): it cannot be put away until a ShipBay admin releases it.', new.psku, coalesce(new.hold_reason, 'no reason given'); end if;
  if tg_op = 'UPDATE' and old.held and not new.held and new.hold_disposition is distinct from 'released' then raise exception 'A HOLD is lifted only by a recorded release.'; end if;
  return new;
end $$;
create trigger wms_pallets_hold_gate before insert or update on wms_pallets for each row execute function _wms_hold_gate();
