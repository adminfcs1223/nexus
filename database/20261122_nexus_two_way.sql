-- APPLIED TO PRODUCTION 2026-11-22 (early morning), together, in one transaction with a read-only self-test. For reference; do not re-run.
-- Nexus two-way link for a site on its own system (Derek, 2026-11-22: Souled is "its own build, two way").
-- Into Nexus (admin key): the site keeps its bookings and product list pushed here, as often as it likes; the same call again
--   changes the same booking, so the site can simply re-send whatever it holds.
-- Out of Nexus (admin key): a numbered feed of what happened on the floor to that site's goods. The site asks for everything
--   after the last number it has; nothing is missed if it was offline.
-- Additive: one table, one trigger function on wms_pallets and inbound_shipments that can never block either, two new
-- functions. One function from v2 is replaced: nexus_api_shipment_save (same arguments; it now also takes the items).
begin;
create table public.nexus_events (id bigserial primary key, at timestamptz not null default now(), org_id uuid, kind text not null, pallet_id uuid, inbound_id uuid);
create index nexus_events_org on public.nexus_events (org_id, id);
alter table public.nexus_events enable row level security;
revoke all on public.nexus_events from public, anon, authenticated, service_role; revoke all on sequence public.nexus_events_id_seq from public, anon, authenticated, service_role;

create function public._nexus_event_trg() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare k text;
begin
  begin
    if tg_table_name = 'inbound_shipments' then
      if tg_op = 'UPDATE' and new.status is distinct from old.status and new.status in ('received', 'discrepancy', 'cancelled') then insert into nexus_events (org_id, kind, inbound_id) values (new.org_id, 'shipment_' || new.status, new.id); end if;
    elsif tg_op = 'INSERT' then insert into nexus_events (org_id, kind, pallet_id) values (new.org_id, 'pallet_received', new.id);
    else
      k := case when new.status = 'void' and old.status <> 'void' then 'pallet_voided' when new.status = 'stored' and old.status <> 'stored' then 'pallet_put_away'
                when new.status = 'stored' and new.location_id is distinct from old.location_id then 'pallet_moved' when new.held and not old.held then 'pallet_on_hold' when old.held and not new.held then 'pallet_released' end;
      if k is not null then insert into nexus_events (org_id, kind, pallet_id, inbound_id) values (new.org_id, k, new.id, new.inbound_id); end if;
    end if;
  exception when others then null;   -- the feed must never stop a receipt or a booking
  end;
  return null;
end $$;
revoke all on function public._nexus_event_trg() from public, anon, authenticated, service_role;
create trigger nexus_event_pallet after insert or update on public.wms_pallets for each row execute function public._nexus_event_trg();
create trigger nexus_event_shipment after update on public.inbound_shipments for each row execute function public._nexus_event_trg();

-- the feed: what happened to this site's goods after event number p_after
create function public.nexus_api_events(p_key text, p_after bigint default 0, p_limit integer default 200) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare a record; v jsonb;
begin
  select * into a from _nexus_api_auth(p_key);
  if a.access <> 'admin' then raise exception 'The event feed needs the admin key.'; end if;
  select coalesce(jsonb_agg(x.j order by x.id), '[]') into v from (
    select e.id, jsonb_build_object('id', e.id, 'at', e.at, 'kind', e.kind, 'brand', g.name, 'org_id', e.org_id,
      'pallet', case when p.id is not null then jsonb_build_object('psku', p.psku, 'status', p.status, 'item', p.item_name, 'item_no', p.item_no, 'cartons', p.cartons, 'units_per_carton', p.units_per_carton, 'units', p.units_total,
        'position', (select code from locations where id = p.location_id), 'held', p.held, 'hold_reason', p.hold_reason, 'received_at', p.received_at, 'stored_at', p.stored_at,
        'contents', (select coalesce(jsonb_agg(jsonb_build_object('sku', c.item_no, 'name', c.item_name, 'cartons', c.n, 'units', c.u) order by c.item_name), '[]')
                     from (select item_no, item_name, count(*) n, sum(units_per_carton) u from wms_cartons where pallet_id = p.id group by 1, 2) c)) end,
      'shipment', case when i.id is not null then jsonb_build_object('id', i.id, 'reference', i.reference, 'status', i.status, 'expected_at', i.expected_at, 'pallets_booked', i.pallets, 'cartons_booked', i.cartons, 'received_at', i.received_at,
        'pallets_received', (select count(*) from wms_pallets w where w.inbound_id = i.id and w.status <> 'void'), 'cartons_received', (select coalesce(sum(w.cartons), 0) from wms_pallets w where w.inbound_id = i.id and w.status <> 'void')) end) j
    from nexus_events e join orgs g on g.id = e.org_id left join wms_pallets p on p.id = e.pallet_id left join inbound_shipments i on i.id = coalesce(e.inbound_id, p.inbound_id)
    where e.org_id = any(a.org_ids) and e.id > coalesce(p_after, 0) order by e.id limit least(greatest(coalesce(p_limit, 200), 1), 1000)) x;
  return jsonb_build_object('events', v, 'last', coalesce((select max((y ->> 'id')::bigint) from jsonb_array_elements(v) y), coalesce(p_after, 0)));
end $$;

-- the site's product list for one of its brands: new products are added, known ones are renamed. Nothing is removed.
create function public.nexus_api_products(p_key text, p_body jsonb) returns integer language plpgsql security definer set search_path to 'public' as $$
declare a record; v_org uuid := nullif(p_body ->> 'org_id', '')::uuid; l jsonb; n integer := 0; v_sku text;
begin
  select * into a from _nexus_api_auth(p_key);
  if a.access <> 'admin' then raise exception 'Product lists need the admin key.'; end if;
  if v_org is null or not v_org = any(a.org_ids) then raise exception 'Pick one of this site''s brands.'; end if;
  if jsonb_typeof(p_body -> 'products') is distinct from 'array' or jsonb_array_length(p_body -> 'products') > 2000 then raise exception 'Send up to 2000 products at a time.'; end if;
  for l in select * from jsonb_array_elements(p_body -> 'products') loop
    v_sku := btrim(coalesce(l ->> 'sku', ''));
    if v_sku = '' or btrim(coalesce(l ->> 'name', '')) = '' then raise exception 'Every product needs its sku and name.'; end if;
    update skus set name = left(btrim(l ->> 'name'), 300), barcode = coalesce(nullif(btrim(l ->> 'barcode'), ''), barcode) where org_id = v_org and sku = v_sku;
    if not found then insert into skus (org_id, sku, name, barcode) values (v_org, v_sku, left(btrim(l ->> 'name'), 300), nullif(btrim(l ->> 'barcode'), '')); end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- book or change an incoming shipment, with what is on it. No id: the brand + reference names the booking, so sending it
-- again changes it instead of making a second one. A new booking waits for Nexus to confirm it. Items are replaced only
-- while nothing has been received against the booking.
create or replace function public.nexus_api_shipment_save(p_key text, p_body jsonb) returns uuid language plpgsql security definer set search_path to 'public' as $$
declare a record; i inbound_shipments; v_id uuid := nullif(p_body ->> 'id', '')::uuid; v_org uuid := nullif(p_body ->> 'org_id', '')::uuid; v_day date := nullif(p_body ->> 'expected_at', '')::date; v_pal int := coalesce((p_body ->> 'pallets')::int, 0);
  v_ref text := btrim(coalesce(p_body ->> 'reference', '')); l jsonb; v_sku uuid;
begin
  select * into a from _nexus_api_auth(p_key);
  if a.access <> 'admin' or not (a.can ->> 'calendar')::boolean then raise exception 'This key cannot change the shipment calendar.'; end if;
  if v_id is null and v_org is not null and v_ref <> '' then select id into v_id from inbound_shipments where org_id = v_org and org_id = any(a.org_ids) and reference = v_ref and status <> 'cancelled' order by created_at desc limit 1; end if;
  if v_id is not null then
    select * into i from inbound_shipments where id = v_id and org_id = any(a.org_ids) for update;
    if i.id is null or i.status = 'cancelled' then raise exception 'Shipment not on file for this connection.'; end if;
    if (p_body ->> 'cancel')::boolean then
      if exists (select 1 from wms_pallets where inbound_id = i.id and status <> 'void') then raise exception 'Pallets were already received against this shipment.'; end if;
      update inbound_shipments set status = 'cancelled' where id = i.id; return i.id;
    end if;
  end if;
  if v_day is null or v_pal < 1 or v_pal > 200 then raise exception 'An expected date and 1 to 200 pallets are needed.'; end if;
  if v_id is null then
    if v_org is null or not v_org = any(a.org_ids) then raise exception 'Pick one of this connection''s brands.'; end if;
    if v_ref = '' then raise exception 'Give the shipment a reference.'; end if;
    insert into inbound_shipments (org_id, reference, status, origin, expected_at, pallets, cartons, notes)
    values (v_org, v_ref, 'expected', nullif(btrim(p_body ->> 'origin'), ''), v_day, v_pal, coalesce((p_body ->> 'cartons')::int, 0), nullif(btrim(coalesce(p_body ->> 'notes', '') || ' [booked from ' || a.name || ']'), '')) returning * into i;
  elsif i.status in ('expected', 'in_transit') then
    update inbound_shipments set expected_at = v_day, pallets = v_pal, cartons = coalesce((p_body ->> 'cartons')::int, cartons), origin = coalesce(nullif(btrim(p_body ->> 'origin'), ''), origin), notes = case when p_body ? 'notes' then nullif(btrim(p_body ->> 'notes'), '') else notes end where id = i.id;
  else return i.id;   -- already received: nothing about it can change from the site
  end if;
  if jsonb_typeof(p_body -> 'items') = 'array' and not exists (select 1 from wms_pallets where inbound_id = i.id and status <> 'void') then
    delete from inbound_lines where inbound_id = i.id;
    for l in select * from jsonb_array_elements(p_body -> 'items') loop
      if btrim(coalesce(l ->> 'sku', '')) = '' or coalesce((l ->> 'qty')::int, 0) < 1 then raise exception 'Each item needs its sku and its expected units.'; end if;
      select id into v_sku from skus where org_id = i.org_id and sku = btrim(l ->> 'sku');
      if v_sku is null then insert into skus (org_id, sku, name) values (i.org_id, btrim(l ->> 'sku'), left(coalesce(nullif(btrim(l ->> 'name'), ''), btrim(l ->> 'sku')), 300)) returning id into v_sku; end if;
      if exists (select 1 from inbound_lines where inbound_id = i.id and sku_id = v_sku) then update inbound_lines set qty_expected = qty_expected + (l ->> 'qty')::int where inbound_id = i.id and sku_id = v_sku;
      else insert into inbound_lines (inbound_id, sku_id, qty_expected, qty_received) values (i.id, v_sku, (l ->> 'qty')::int, 0); end if;
    end loop;
  end if;
  return i.id;
end $$;

do $$ declare f text; begin
  for f in select p.oid::regprocedure::text from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('nexus_api_events', 'nexus_api_products') loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f); execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;
commit;
