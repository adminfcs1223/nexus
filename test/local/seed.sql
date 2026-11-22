-- Synthetic floor: made-up brands, products and pallets. Nothing here is a real client's stock.
insert into profiles (id, role, full_name, email) values ('aa000000-0000-4000-8000-000000000002', 'shipbay_admin', 'Test Admin', 'admin@example.test'), ('aa000000-0000-4000-8000-000000000001', 'wms_employee', 'Test Floor', 'floor@example.test');
insert into orgs (id, name, slug) values ('bb000000-0000-4000-8000-00000000000a', 'Sample Records', 'a'), ('bb000000-0000-4000-8000-00000000000b', 'Sample Sneakers', 'b'), ('bb000000-0000-4000-8000-00000000000c', 'Sample Candles', 'c');
insert into locations (code, zone, kind) select 'P-' || lpad(n::text, 2, '0'), case when n <= 36 then 'inbound' else 'outbound' end, 'pallet' from generate_series(1, 72) n;
insert into locations (code, zone, kind) values ('STG-01', 'staging', 'floor'), ('STG-02', 'staging', 'floor');
insert into skus (id, org_id, sku, name) values ('cc000000-0000-4000-8000-000000000001', 'bb000000-0000-4000-8000-00000000000a', 'REC-LP-135', 'Sample LP, volume 135'), ('cc000000-0000-4000-8000-000000000002', 'bb000000-0000-4000-8000-00000000000a', 'REC-MAILER', 'Record mailer'),
  ('cc000000-0000-4000-8000-000000000003', 'bb000000-0000-4000-8000-00000000000b', 'SNK-RUN-10', 'Sample runner, size 10'), ('cc000000-0000-4000-8000-000000000004', 'bb000000-0000-4000-8000-00000000000c', 'CDL-SOY-8', 'Soy candle 8 oz');
select set_config('request.jwt.claims', '{"sub":"aa000000-0000-4000-8000-000000000001"}', false);
do $$ declare r record; v uuid; i int; n int := 0; begin
  for r in select * from (values ('a', 1, 12, 20, 34, 3), ('a', 1, 10, 20, 27, 5), ('a', 2, 16, 50, 21, 8), ('a', 1, 12, 20, 14, 12), ('a', 2, 8, 50, 9, 13), ('a', 1, 12, 20, 6, 21), ('a', 1, 9, 20, 2, 22),
      ('b', 3, 12, 6, 41, 37), ('b', 3, 12, 6, 30, 38), ('b', 3, 10, 6, 19, 40), ('b', 3, 12, 6, 11, 44), ('b', 3, 6, 6, 4, 55), ('b', 3, 12, 6, 3, 56),
      ('c', 4, 24, 12, 16, 60), ('c', 4, 24, 12, 8, 61), ('c', 4, 18, 12, 1, 0), ('a', 1, 12, 20, 0, 0), ('b', 3, 8, 6, 0, -1)) t(org, sku, cartons, upc, days, pos) loop
    n := n + 1;
    insert into wms_pallets (org_id, sku_id, item_no, item_name, cartons, units_per_carton, units_total, received_at, received_by, received_by_name, reference, fba, held, hold_reason)
    select ('bb000000-0000-4000-8000-00000000000' || r.org)::uuid, s.id, 'ITM-' || lpad((100 + r.sku)::text, 6, '0'), s.name, r.cartons, r.upc, r.cartons * r.upc, now() - (r.days || ' days')::interval - interval '3 hours', auth.uid(), 'Test Floor',
      case when r.org = 'a' then 'VOL-135' end, r.org = 'b' and n % 2 = 0, r.pos = -1, case when r.pos = -1 then 'Carton count short by 2' end
    from skus s where s.id = ('cc000000-0000-4000-8000-00000000000' || r.sku)::uuid returning id into v;
    for i in 1..r.cartons loop insert into wms_cartons (pallet_id, org_id, seq, code, sku_id, item_no, item_name, units_per_carton, scanned_at)
      select v, p.org_id, i, replace(p.psku, 'PSKU-', 'C') || '-' || lpad(i::text, 3, '0'), p.sku_id, p.item_no, p.item_name, p.units_per_carton, case when r.pos > 0 then p.received_at + interval '20 minutes' end from wms_pallets p where p.id = v; end loop;
    if r.pos > 0 then
      update wms_pallets set status = 'stored', location_id = (select id from locations where code = 'P-' || lpad(r.pos::text, 2, '0')), counted_at = received_at + interval '25 minutes', counted_by_name = 'Test Floor',
        stored_at = received_at + interval '40 minutes', stored_by_name = 'Test Floor', label_prints = 1, last_printed_at = received_at where id = v;
      insert into wms_activity (at, org_id, kind, ref, actor_name, detail) select stored_at, org_id, 'pallet_putaway', psku, 'Test Floor', jsonb_build_object('location', 'P-' || lpad(r.pos::text, 2, '0')) from wms_pallets where id = v;
    end if;
    insert into wms_activity (at, org_id, kind, ref, actor_name) select received_at, org_id, 'pallet_received', psku, 'Test Floor' from wms_pallets where id = v;
  end loop;
end $$;
insert into inbound_shipments (org_id, reference, origin, expected_at, pallets, cartons, approved_at, notes) values
  ('bb000000-0000-4000-8000-00000000000a', 'VOL-136 records', 'Pressing plant', current_date + 2, 6, 175, now(), null), ('bb000000-0000-4000-8000-00000000000a', 'VOL-136 mailers', 'Box maker', current_date + 2, 16, 0, now(), null),
  ('bb000000-0000-4000-8000-00000000000b', 'Runner restock', 'Supplier', current_date + 6, 4, 48, now(), null), ('bb000000-0000-4000-8000-00000000000c', 'Holiday candles', null, current_date + 11, 3, 72, null, 'Lift gate needed'),
  ('bb000000-0000-4000-8000-00000000000b', 'Returns pallet', null, current_date - 3, 1, 9, now(), null);
insert into inbound_lines (inbound_id, sku_id, qty_expected) select i.id, s.id, case s.sku when 'REC-LP-135' then 3500 when 'REC-MAILER' then 4000 when 'SNK-RUN-10' then 288 else 864 end
from inbound_shipments i join skus s on s.org_id = i.org_id and ((i.reference like '%records' and s.sku = 'REC-LP-135') or (i.reference like '%mailers' and s.sku = 'REC-MAILER') or i.org_id <> 'bb000000-0000-4000-8000-00000000000a') where i.expected_at >= current_date;
