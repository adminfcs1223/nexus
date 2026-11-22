-- Local stand-in for the parts of the ShipBay database Nexus touches (column lists read from production's catalog 2026-11-21;
-- no rows). Synthetic data only. Used by test/local to run the real nexus_* functions behind the real screens.
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub', '')::uuid $$;
grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
create table orgs (id uuid primary key default gen_random_uuid(), name text not null, slug text, status text not null default 'active', external_wms boolean not null default false);
create table profiles (id uuid primary key, role text, full_name text, email text, active boolean default true, employee_no int);
create table locations (id uuid primary key default gen_random_uuid(), code text not null unique, zone text, kind text not null default 'pallet', active boolean not null default true, created_at timestamptz not null default now());
create table skus (id uuid primary key default gen_random_uuid(), org_id uuid not null, sku text not null, name text);
create table inbound_shipments (id uuid primary key default gen_random_uuid(), org_id uuid not null, reference text not null, status text not null default 'expected', carrier text, tracking text, origin text, expected_at date, received_at timestamptz,
  pallets int not null default 0, cartons int not null default 0, notes text, created_by uuid, created_at timestamptz not null default now(), receiving_waived boolean not null default false, approved_at timestamptz, approved_by uuid, approved_by_name text);
create table inbound_lines (id uuid primary key default gen_random_uuid(), inbound_id uuid not null, sku_id uuid not null, qty_expected int not null, qty_received int not null default 0);
create table wms_receipt_links (id uuid primary key default gen_random_uuid(), inbound_id uuid not null, org_id uuid, batch_key text unique, mode text not null, pallets int, cartons int, hold_reason text, received_by_name text, created_at timestamptz not null default now());
create sequence wms_psku_seq;
create table wms_pallets (id uuid primary key default gen_random_uuid(), psku text not null unique default 'PSKU-' || lpad(nextval('wms_psku_seq')::text, 6, '0'), org_id uuid not null, status text not null default 'open', reference text, carrier text, cartons int, notes text,
  batch_key text, batch_pos int not null default 1, batch_size int not null default 1, client_key text, received_at timestamptz not null default now(), received_by uuid, received_by_name text, label_prints int not null default 0, last_printed_at timestamptz,
  voided_at timestamptz, voided_by uuid, void_reason text, created_at timestamptz not null default now(), sku_id uuid, item_no text, item_name text, units_per_carton int, location_id uuid references locations(id), counted_at timestamptz, counted_by_name text,
  stored_at timestamptz, stored_by_name text, mixed boolean not null default false, fba boolean not null default false, cle boolean not null default false, units_total int, inbound_id uuid, held boolean not null default false, hold_reason text);
create table wms_cartons (id uuid primary key default gen_random_uuid(), pallet_id uuid not null, org_id uuid not null, seq int not null, code text not null unique, scanned_at timestamptz, scanned_by_name text, sku_id uuid, item_no text, item_name text,
  units_per_carton int, fba boolean not null default false, open_box_at timestamptz, open_units int, open_by_name text, cle boolean not null default false);
create table inventory_moves (id bigserial primary key, org_id uuid, sku_id uuid, qty int, reason text, ref_type text, ref_id uuid, note text, created_by uuid, location_id uuid, created_at timestamptz default now());
create table wms_activity (id bigserial primary key, at timestamptz not null default now(), org_id uuid, kind text not null, qty int not null default 1, ref text, actor uuid, actor_name text, detail jsonb);
-- stock posting on put-away / move, reduced from production's _wms_post_stock (whole-pallet units only)
create function _wms_post_stock_trg() returns trigger language plpgsql security definer as $$
declare v int := coalesce(new.units_total, new.cartons * new.units_per_carton, 0);
begin
  delete from inventory_moves where ref_type = 'wms_pallet' and ref_id = new.id;
  if new.status = 'stored' and new.location_id is not null and new.sku_id is not null then insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, location_id) values (new.org_id, new.sku_id, v, 'receive', 'wms_pallet', new.id, new.location_id); end if;
  return null;
end $$;
create trigger wms_pallet_stock after insert or update on wms_pallets for each row execute function _wms_post_stock_trg();

-- STAND-IN for production's wms_receive_booking (same arguments, same checks that matter here: approved, open, not closed, one
-- request key = one receipt). Production's version also does request signatures, NCC, mixed pallets and units; Nexus calls the real one.
create function public.wms_receive_booking(p_inbound uuid, p_org uuid, p_lines jsonb, p_pallets integer, p_notes text, p_key text, p_mode text, p_hold_reason text) returns setof wms_pallets
language plpgsql security definer set search_path to 'public' as $$
declare b inbound_shipments; l jsonb; v uuid; n int; i int; v_cartons int := 0; s skus; v_who text := (select coalesce(full_name, email) from profiles where id = auth.uid());
begin
  if v_who is null then raise exception 'This login cannot receive pallets.'; end if;
  if exists (select 1 from wms_receipt_links where batch_key = p_key) then return query select * from wms_pallets where batch_key = p_key order by batch_pos; return; end if;
  select * into b from inbound_shipments where id = p_inbound for update;
  if b.id is null or b.org_id <> p_org then raise exception 'That booking is not on file.'; end if;
  if b.approved_at is null then raise exception 'That booking has not been approved yet.'; end if;
  if b.status not in ('expected', 'in_transit') then raise exception 'That booking is %: it cannot take more pallets.', b.status; end if;
  if exists (select 1 from wms_receipt_links where inbound_id = b.id and mode = 'final') then raise exception 'That booking was closed by its last receipt: it cannot take more pallets.'; end if;
  if p_mode = 'hold' and coalesce(btrim(p_hold_reason), '') = '' then raise exception 'Say why it is on HOLD.'; end if;
  l := p_lines -> 0; select * into s from skus where id = (l ->> 'sku')::uuid and org_id = p_org; if s.id is null then raise exception 'One of those products is not on this brand''s list.'; end if;
  for n in 1..coalesce(p_pallets, 1) loop
    insert into wms_pallets (org_id, sku_id, item_no, item_name, cartons, units_per_carton, units_total, received_by, received_by_name, notes, batch_key, batch_pos, inbound_id, held, hold_reason, mixed)
    values (p_org, s.id, 'ITM-' || upper(left(s.sku, 6)), s.name, (l ->> 'cartons')::int, nullif(l ->> 'units_per_carton', '')::int, (l ->> 'cartons')::int * nullif(l ->> 'units_per_carton', '')::int, auth.uid(), v_who, p_notes, p_key, n, b.id, p_mode = 'hold', case when p_mode = 'hold' then btrim(p_hold_reason) end, jsonb_array_length(p_lines) > 1) returning id into v;
    for i in 1..(l ->> 'cartons')::int loop insert into wms_cartons (pallet_id, org_id, seq, code, sku_id, item_name, units_per_carton) select v, p_org, i, replace(psku, 'PSKU-', 'C') || '-' || lpad(i::text, 3, '0'), s.id, s.name, nullif(l ->> 'units_per_carton', '')::int from wms_pallets where id = v; end loop;
    v_cartons := v_cartons + (l ->> 'cartons')::int;
  end loop;
  insert into wms_receipt_links (inbound_id, org_id, batch_key, mode, pallets, cartons, hold_reason, received_by_name) values (b.id, p_org, p_key, p_mode, coalesce(p_pallets, 1), v_cartons, nullif(btrim(p_hold_reason), ''), v_who);
  return query select * from wms_pallets where batch_key = p_key order by batch_pos;
end $$;
grant execute on function public.wms_receive_booking(uuid, uuid, jsonb, integer, text, text, text, text) to authenticated;
