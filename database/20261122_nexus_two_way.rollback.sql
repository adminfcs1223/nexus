-- Undo 20261122_nexus_two_way.sql. nexus_api_shipment_save stays in its newer form (it is a superset of the v2 one).
begin;
drop trigger if exists nexus_event_pallet on public.wms_pallets; drop trigger if exists nexus_event_shipment on public.inbound_shipments;
drop function if exists public.nexus_api_products(text, jsonb), public.nexus_api_events(text, bigint, integer), public._nexus_event_trg();
drop table if exists public.nexus_events;
commit;
