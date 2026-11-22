-- APPLIED TO PRODUCTION 2026-11-22 (early morning), together, in one transaction with a read-only self-test. For reference; do not re-run.
-- Nexus sites (Derek, 2026-11-22). A site is a WMS that uses this warehouse: ShipBay, Souled. Receiving and the calendar
-- show the site first and the brand as "c/o". A brand belongs to one site. Sites reuse the nexus_clients rows (a site IS a
-- connection: its brands, its two keys, its permissions), plus how it connects:
--   shared = its WMS runs on this database, so its bookings and products are live here with nothing to sync
--   api    = its own system; it reaches Nexus with its keys and Nexus shows when it was last heard from
-- Additive: one column, new functions, and the two sites that exist today. Nothing existing is replaced.
begin;
alter table public.nexus_clients add column if not exists kind text not null default 'api' check (kind in ('shared', 'api'));

-- the two sites that exist today, from the flag the brands already carry (orgs.external_wms). Their keys are unknown random
-- values until an admin makes a key, so nothing can connect with them.
insert into public.nexus_clients (name, org_ids, key_hash, kind)
select 'ShipBay', array_agg(id order by name), encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'utf8')), 'hex'), 'shared'
from public.orgs where not external_wms and status <> 'churned' and not exists (select 1 from public.nexus_clients) having count(*) > 0;
insert into public.nexus_clients (name, org_ids, key_hash, kind)
select 'Souled', array_agg(id order by name), encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'utf8')), 'hex'), 'api'
from public.orgs where external_wms and status <> 'churned' and not exists (select 1 from public.nexus_clients where name <> 'ShipBay') having count(*) > 0;

-- every site with its c/o brands and how fresh its data is. Admins also get permissions and key use.
create function public.nexus_sites() returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare c record;
begin
  select * into c from _nexus_staff();
  return jsonb_build_object(
    'sites', (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'name', n.name, 'kind', n.kind, 'active', n.active, 'org_ids', n.org_ids,
        'brands', (select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) order by g.name), '[]') from orgs g where g.id = any(n.org_ids)),
        'heard_at', case when n.kind = 'api' then greatest(n.last_used_at, n.admin_last_used_at) end,
        'last_change', (select max(t) from (select max(i.created_at) t from inbound_shipments i where i.org_id = any(n.org_ids) union all select max(p.received_at) from wms_pallets p where p.org_id = any(n.org_ids)) x),
        'open_shipments', (select count(*) from inbound_shipments i where i.org_id = any(n.org_ids) and i.status in ('expected', 'in_transit')),
        'pallets', (select count(*) from wms_pallets p where p.org_id = any(n.org_ids) and p.status <> 'void'))
        || case when c.role = 'shipbay_admin' then jsonb_build_object('perms', _nexus_perms(n.perms), 'has_admin_key', n.admin_key_hash is not null, 'floor_used_at', n.last_used_at, 'admin_used_at', n.admin_last_used_at, 'created_at', n.created_at) else '{}'::jsonb end
        order by n.created_at), '[]') from nexus_clients n),
    'unassigned', (select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) order by g.name), '[]') from orgs g where g.status <> 'churned' and not exists (select 1 from nexus_clients n where g.id = any(n.org_ids))));
end $$;

-- add a site (p_id null: both keys come back once) or change one. A brand can sit in one site only.
create function public.nexus_site_save(p_id uuid, p_name text, p_kind text, p_org_ids uuid[], p_perms jsonb) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare c record; v_id uuid; kf text; ka text; v_clash text;
begin
  select * into c from _nexus_staff();
  if c.role <> 'shipbay_admin' then raise exception 'Only a Nexus admin can set up a site.'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'Name the site.'; end if;
  if p_kind not in ('shared', 'api') then raise exception 'Say how the site connects.'; end if;
  if exists (select 1 from nexus_clients where lower(name) = lower(btrim(p_name)) and id is distinct from p_id) then raise exception 'There is already a site called %.', btrim(p_name); end if;
  if coalesce(cardinality(p_org_ids), 0) = 0 then raise exception 'Pick at least one brand for the site.'; end if;
  if (select count(*) from orgs where id = any(p_org_ids)) is distinct from cardinality(p_org_ids) then raise exception 'One of those brands is not on file.'; end if;
  select g.name || ' is already under ' || n.name into v_clash from nexus_clients n join orgs g on g.id = any(n.org_ids) where g.id = any(coalesce(p_org_ids, '{}')) and n.id is distinct from p_id limit 1;
  if v_clash is not null then raise exception '%. A brand belongs to one site.', v_clash; end if;
  if p_id is null then
    kf := _nexus_newkey(); ka := _nexus_newkey();
    insert into nexus_clients (name, org_ids, key_hash, admin_key_hash, perms, kind, created_by) values (btrim(p_name), coalesce(p_org_ids, '{}'), _nexus_hash(kf), _nexus_hash(ka), _nexus_perms(p_perms), p_kind, c.uid) returning id into v_id;
    return jsonb_build_object('id', v_id, 'floor_key', kf, 'admin_key', ka);
  end if;
  update nexus_clients set name = btrim(p_name), org_ids = coalesce(p_org_ids, '{}'), perms = _nexus_perms(p_perms), kind = p_kind where id = p_id returning id into v_id;
  if v_id is null then raise exception 'Site not on file.'; end if;
  return jsonb_build_object('id', v_id);
end $$;

-- Receiving, by site: the shipments of every brand under it, each marked with its c/o brand
create function public.nexus_receiving_site(p_site uuid) returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_orgs uuid[];
begin
  perform 1 from _nexus_staff();
  if p_site is null then select coalesce(array_agg(g.id), '{}') into v_orgs from orgs g where g.status <> 'churned' and not exists (select 1 from nexus_clients n where g.id = any(n.org_ids));
  else select org_ids into v_orgs from nexus_clients where id = p_site; end if;
  return (select coalesce(jsonb_agg(x.j || jsonb_build_object('org_id', x.org_id, 'brand', x.brand) order by (x.j ->> 'status' in ('received', 'discrepancy')), x.j ->> 'expected_at' nulls last, x.brand, x.j ->> 'reference'), '[]')
    from (select g.id org_id, g.name brand, jsonb_array_elements(nexus_receiving(g.id)) j from orgs g where g.id = any(coalesce(v_orgs, '{}'))) x);
end $$;

do $$ declare f text; begin
  for f in select p.oid::regprocedure::text from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('nexus_sites', 'nexus_site_save', 'nexus_receiving_site') loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f); execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
commit;
