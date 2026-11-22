-- Undo 20261122_nexus_sites.sql. The two seeded sites stay as plain connections; remove them in Nexus if they are not wanted.
begin;
drop function if exists public.nexus_receiving_site(uuid), public.nexus_site_save(uuid, text, text, uuid[], jsonb), public.nexus_sites();
alter table public.nexus_clients drop column if exists kind;
commit;
