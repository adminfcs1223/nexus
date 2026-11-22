-- Functions that are live in production but not in database/*.sql (definitions read from production 2026-11-21).
create or replace function public.nexus_positions_add(p_codes text[], p_zone text, p_kind text default 'pallet') returns integer language plpgsql security definer set search_path to 'public' as $$
declare c record; n integer;
begin
  select * into c from _nexus_staff();
  if c.role <> 'shipbay_admin' then raise exception 'Only a Nexus admin can add positions.'; end if;
  if p_kind not in ('pallet', 'floor') then raise exception 'Pallet position or floor spot.'; end if;
  if coalesce(cardinality(p_codes), 0) = 0 or exists (select 1 from unnest(p_codes) x where upper(btrim(x)) !~ '^[A-Z0-9-]{2,12}$') then raise exception 'Position codes are 2-12 letters, digits or dashes.'; end if;
  if exists (select 1 from locations l where upper(l.code) = any (select upper(btrim(x)) from unnest(p_codes) x)) then raise exception 'One of those positions already exists.'; end if;
  insert into locations (code, zone, kind, active) select upper(btrim(x)), nullif(btrim(p_zone), ''), p_kind, true from unnest(p_codes) x;
  get diagnostics n = row_count; return n;
end $$;
create or replace function public.nexus_brands() returns table(id uuid, name text) language plpgsql stable security definer set search_path to 'public' as $$
begin perform 1 from _nexus_staff(); return query select o.id, o.name from orgs o where o.status <> 'churned' order by o.name; end $$;
create or replace function public.nexus_shipments(p_from date, p_to date) returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform 1 from _nexus_staff();
  return (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'org_id', i.org_id, 'brand', g.name, 'reference', i.reference, 'origin', i.origin, 'expected_at', i.expected_at,
      'pallets', i.pallets, 'cartons', i.cartons, 'status', i.status, 'approved', i.approved_at is not null, 'notes', i.notes,
      'received_pallets', (select count(*) from wms_pallets p where p.inbound_id = i.id and p.status <> 'void'),
      'closed', exists (select 1 from wms_receipt_links k where k.inbound_id = i.id and k.mode = 'final'),
      'lines', (select coalesce(jsonb_agg(jsonb_build_object('sku', s.sku, 'name', s.name, 'qty', n.qty_expected) order by s.sku), '[]') from inbound_lines n join skus s on s.id = n.sku_id where n.inbound_id = i.id))
      order by i.expected_at, g.name), '[]')
    from inbound_shipments i join orgs g on g.id = i.org_id where i.status <> 'cancelled' and i.expected_at between p_from and p_to);
end $$;
create or replace function public.nexus_shipment_create(p_org uuid, p_reference text, p_origin text, p_expected date, p_pallets integer, p_cartons integer, p_notes text, p_lines jsonb) returns uuid language plpgsql security definer set search_path to 'public' as $$
declare c record; v_id uuid; l jsonb;
begin
  select * into c from _nexus_staff();
  if c.role not in ('shipbay_admin', 'shipbay_staff') then raise exception 'Only ShipBay admin or staff can book a shipment.'; end if;
  if not exists (select 1 from orgs where id = p_org) then raise exception 'Pick the brand.'; end if;
  if coalesce(btrim(p_reference), '') = '' or p_expected is null then raise exception 'A reference and the expected date are needed.'; end if;
  if coalesce(p_pallets, 0) < 1 or p_pallets > 200 then raise exception 'Pallets expected: 1 to 200.'; end if;
  insert into inbound_shipments (org_id, reference, status, origin, expected_at, pallets, cartons, notes, created_by, approved_at, approved_by, approved_by_name)
  values (p_org, btrim(p_reference), 'expected', nullif(btrim(p_origin), ''), p_expected, p_pallets, coalesce(p_cartons, 0), nullif(btrim(p_notes), ''), c.uid, now(), c.uid, c.who) returning id into v_id;
  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    insert into inbound_lines (inbound_id, sku_id, qty_expected, qty_received) values (v_id, (l ->> 'sku_id')::uuid, (l ->> 'qty')::int, 0);
  end loop;
  return v_id;
end $$;
create or replace function public.nexus_putaway(p_psku text, p_location text) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare c record; p wms_pallets; l locations; v_loc text := upper(regexp_replace(btrim(coalesce(p_location, '')), '^LOC-', '', 'i')); v_psku text := upper(btrim(coalesce(p_psku, '')));
begin
  select * into c from _nexus_staff();
  select * into p from wms_pallets where upper(psku) = v_psku for update;
  if p.id is null then raise exception 'Pallet % is not on file.', coalesce(nullif(v_psku, ''), '(blank)'); end if;
  if p.status = 'void' then raise exception '% was voided.', p.psku; end if;
  if p.status = 'stored' then raise exception '% is already put away.', p.psku; end if;
  if p.held then raise exception '% is on HOLD (%): an admin must release it first.', p.psku, coalesce(p.hold_reason, 'no reason given'); end if;
  select * into l from locations where upper(code) = v_loc and active;
  if l.id is null or l.kind not in ('pallet', 'floor') then raise exception 'Position % is not a pallet position.', coalesce(nullif(v_loc, ''), '(blank)'); end if;
  if l.kind = 'pallet' and exists (select 1 from wms_pallets x where x.location_id = l.id and x.status = 'stored' and x.id <> p.id) then raise exception 'Position % already holds a pallet.', l.code; end if;
  update wms_pallets set location_id = l.id, status = 'stored', stored_at = now(), stored_by_name = c.who,
    counted_at = coalesce(counted_at, now()), counted_by_name = coalesce(counted_by_name, c.who) where id = p.id;
  return jsonb_build_object('psku', p.psku, 'location', l.code, 'units_posted', (select coalesce(sum(qty), 0) from inventory_moves where ref_type = 'wms_pallet' and ref_id = p.id));
end $$;
grant execute on function public.nexus_putaway(text, text) to authenticated;
grant execute on function public.nexus_positions_add(text[], text, text), public.nexus_brands(), public.nexus_shipments(date, date), public.nexus_shipment_create(uuid, text, text, date, integer, integer, text, jsonb) to authenticated;
