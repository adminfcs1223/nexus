-- The schema gets an owner that nobody can log in as (2026-11-23). Loaded after 008. LOCAL ONLY until approved.
-- Until now everything in schema nexus was owned by the database's own administrator login, so every service function
-- ran with that login's full rights. After this file they run as nexus_owner: a role with no password, no login, no
-- right to create roles or databases, and rights over schema nexus only.
-- It also closes the gap the permission audit named: a function created later by nexus_owner is not runnable by PUBLIC.
-- Run by the database administrator. Migrations after this one are run as:  set role nexus_owner;
do $$ declare r record; s text; begin
  if not exists (select 1 from pg_roles where rolname = 'nexus_owner') then create role nexus_owner nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if;
  execute format('grant nexus_owner to %I', current_user);
  select n.nspname into strict s from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgcrypto';
  execute format('grant usage on schema %I to nexus_owner', s);
  alter schema nexus owner to nexus_owner;
  for r in select c.oid::regclass t from pg_class c where c.relnamespace = 'nexus'::regnamespace and c.relkind in ('r', 'v') loop execute format('alter table %s owner to nexus_owner', r.t); end loop;
  for r in select c.oid::regclass t from pg_class c where c.relnamespace = 'nexus'::regnamespace and c.relkind = 'S' and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a', 'i')) loop execute format('alter sequence %s owner to nexus_owner', r.t); end loop;
  for r in select p.oid::regprocedure sig from pg_proc p where p.pronamespace = 'nexus'::regnamespace loop execute format('alter function %s owner to nexus_owner', r.sig); end loop;
  for r in select t.oid::regtype ty from pg_type t where t.typnamespace = 'nexus'::regnamespace and t.typtype in ('e', 'd') loop execute format('alter type %s owner to nexus_owner', r.ty); end loop;
end $$;
alter default privileges for role nexus_owner revoke execute on functions from public;
