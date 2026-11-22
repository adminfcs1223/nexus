-- Local stand-in for the parts of the ShipBay database Nexus touches (column lists read from production's catalog 2026-11-21;
-- no rows). Synthetic data only. Used by test/local to run the real nexus_* functions behind the real screens.
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub', '')::uuid $$;
grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
create table orgs (id uuid primary key default gen_random_uuid(), name text not null, slug text, status text not null default 'active', external_wms boolean not null default false);
create table profiles (id uuid primary key, role text, full_name text, email text, active boolean default true, employee_no int, org_id uuid);
create table locations (id uuid primary key default gen_random_uuid(), code text not null unique, zone text, kind text not null default 'pallet', active boolean not null default true, created_at timestamptz not null default now());
create table skus (id uuid primary key default gen_random_uuid(), org_id uuid not null, sku text not null, name text not null, barcode text, active boolean not null default true, asins text[] not null default '{}', supplier text, expected_qty int, expected_fba int, expected_fbm int);
create table inbound_shipments (id uuid primary key default gen_random_uuid(), org_id uuid not null, reference text not null, status text not null default 'expected', carrier text, tracking text, origin text, expected_at date, received_at timestamptz,
  pallets int not null default 0, cartons int not null default 0, notes text, created_by uuid, created_at timestamptz not null default now(), receiving_waived boolean not null default false, approved_at timestamptz, approved_by uuid, approved_by_name text);
create table inbound_lines (id uuid primary key default gen_random_uuid(), inbound_id uuid not null, sku_id uuid not null, qty_expected int not null, qty_received int not null default 0);
create table wms_receipt_links (id uuid primary key default gen_random_uuid(), inbound_id uuid not null, org_id uuid not null, batch_key text not null unique, request_sig text not null, request_sig_version smallint not null default 1, mode text not null check (mode in ('partial', 'hold', 'final')), pallets int not null check (pallets > 0), cartons int not null, hold_reason text, diff_pallets int, diff_cartons int, received_by uuid, received_by_name text, created_at timestamptz not null default now());
create table wms_psku_holds (batch_key text not null, pos int not null, num text not null, held_by uuid, held_at timestamptz not null default now(), primary key (batch_key, pos));
create table events (id bigserial primary key, org_id uuid, entity text, entity_id uuid, action text, from_value text, to_value text, actor_id uuid, at timestamptz default now());
create sequence wms_psku_seq;
create table wms_pallets (id uuid primary key default gen_random_uuid(), psku text not null unique default 'PSKU-' || lpad(nextval('wms_psku_seq')::text, 6, '0'), org_id uuid not null, status text not null default 'open', reference text, carrier text, cartons int, notes text,
  batch_key text, batch_pos int not null default 1, batch_size int not null default 1, client_key text, received_at timestamptz not null default now(), received_by uuid, received_by_name text, label_prints int not null default 0, last_printed_at timestamptz,
  voided_at timestamptz, voided_by uuid, void_reason text, created_at timestamptz not null default now(), sku_id uuid, item_no text, item_name text, units_per_carton int, location_id uuid references locations(id), counted_at timestamptz, counted_by_name text,
  stored_at timestamptz, stored_by_name text, mixed boolean not null default false, fba boolean not null default false, cle boolean not null default false, units_total int, inbound_id uuid, held boolean not null default false, hold_reason text, hold_disposition text);
create table wms_cartons (id uuid primary key default gen_random_uuid(), pallet_id uuid not null, org_id uuid not null, seq int not null, code text not null unique, scanned_at timestamptz, scanned_by_name text, sku_id uuid, item_no text, item_name text,
  units_per_carton int, fba boolean not null default false, open_box_at timestamptz, open_units int, open_by_name text, cle boolean not null default false);
create table inventory_moves (id bigserial primary key, org_id uuid, sku_id uuid, qty int, reason text, ref_type text, ref_id uuid, note text, created_by uuid, location_id uuid, created_at timestamptz default now());
create table wms_activity (id bigserial primary key, at timestamptz not null default now(), org_id uuid, kind text not null, qty int not null default 1, ref text, actor uuid, actor_name text, detail jsonb);
-- stock posting on put-away / move, reduced from production's _wms_post_stock (whole-pallet units only)
create function _wms_post_stock_trg() returns trigger language plpgsql security definer as $$
declare v int := coalesce(new.units_total, (select sum(units_per_carton) from wms_cartons where pallet_id = new.id), 0);
begin
  delete from inventory_moves where ref_type = 'wms_pallet' and ref_id = new.id;
  if new.status = 'stored' and new.location_id is not null and new.sku_id is not null then insert into inventory_moves (org_id, sku_id, qty, reason, ref_type, ref_id, location_id) values (new.org_id, new.sku_id, v, 'receive', 'wms_pallet', new.id, new.location_id); end if;
  return null;
end $$;
create trigger wms_pallet_stock after insert or update on wms_pallets for each row execute function _wms_post_stock_trg();

