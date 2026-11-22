-- NEXUS, neutral foundation (final direction, 2026-11-22). For a database of Nexus's own: it references nothing in ShipBay's
-- or Souled's systems. Nexus holds where a company's pallet stands, never what is on it.
-- Phase 1 scope: companies, integration credentials with scopes, location registry, occupancy, the assign / move / release
-- engine, movement history, numbered change feed, audit. The HTTP layer, people's sign-in and the calendar come next.
create schema nexus;

create table nexus.companies (
  id uuid primary key default gen_random_uuid(), code text not null unique check (code ~ '^[A-Z0-9_]{2,20}$'), name text not null,
  active boolean not null default true, created_at timestamptz not null default now());

-- one row per system that calls Nexus. The key is never stored, only its hash. Scopes: read, move, calendar.
create table nexus.integrations (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references nexus.companies(id), source_system text not null,
  key_hash text not null unique, scopes text[] not null default '{read}' check (scopes <@ array['read', 'move', 'calendar'] and cardinality(scopes) > 0),
  active boolean not null default true, created_at timestamptz not null default now(), last_ok_at timestamptz, last_error_at timestamptz, last_error text,
  unique (company_id, source_system));

-- the canonical location registry. capacity null = not limited (staging, dock). A location id and code are never reused.
create table nexus.locations (
  id uuid primary key default gen_random_uuid(), code text not null unique check (code ~ '^[A-Z0-9-]{2,16}$'),
  kind text not null check (kind in ('pallet', 'staging', 'dock')), warehouse text not null, zone text, aisle text, bay text, level text, position text,
  capacity integer check (capacity > 0), status text not null default 'open' check (status in ('open', 'blocked', 'unavailable')), status_reason text,
  restrictions jsonb not null default '{}', map_block text, map_col integer, map_row integer,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), updated_by text);

-- a pallet Nexus has been told about: whose it is and what its own system calls it. Nothing about its contents.
create table nexus.pallets (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references nexus.companies(id), source_system text not null,
  external_id text not null check (length(btrim(external_id)) between 1 and 64), status text not null default 'active' check (status in ('active', 'released')),
  created_at timestamptz not null default now(), unique (company_id, external_id));

-- where each pallet stands right now. The primary key is the rule "a pallet is in one place".
create table nexus.occupancy (
  pallet_id uuid primary key references nexus.pallets(id), location_id uuid not null references nexus.locations(id),
  since timestamptz not null default now(), placed_by text not null);
create index occupancy_location on nexus.occupancy (location_id);

-- every request to assign, move or release, accepted or refused, kept forever. (requester, idempotency_key) is unique:
-- the same request sent twice is answered from this row and changes nothing.
create table nexus.moves (
  id bigserial primary key, at timestamptz not null default now(), kind text not null check (kind in ('assign', 'move', 'release')),
  company_id uuid not null references nexus.companies(id), pallet_id uuid references nexus.pallets(id), external_id text not null,
  from_location uuid references nexus.locations(id), to_location uuid references nexus.locations(id),
  requester text not null, idempotency_key text not null, result text not null, response jsonb not null,
  unique (requester, idempotency_key));
create index moves_pallet on nexus.moves (pallet_id, id desc); create index moves_to on nexus.moves (to_location, id desc); create index moves_from on nexus.moves (from_location, id desc);

-- numbered feed of every change. A system asks for everything after the last number it holds.
create table nexus.change_log (
  seq bigserial primary key, at timestamptz not null default now(), kind text not null, company_id uuid references nexus.companies(id),
  location_id uuid references nexus.locations(id), pallet_id uuid references nexus.pallets(id), schema_version integer not null default 1);

create table nexus.audit_log (
  id bigserial primary key, at timestamptz not null default now(), actor text not null, action text not null, target text, before jsonb, after jsonb);

create function nexus._hash(p text) returns text language sql immutable as $$ select encode(sha256(convert_to(coalesce(p, ''), 'utf8')), 'hex') $$;

-- ───────── the occupancy engine ─────────
-- One function decides every assign, move and release. It never raises for a business refusal: it answers
-- {"ok": false, "error": "<code>", …} and records the refusal, so a caller always gets a code it can act on.
-- Concurrency: the destination location row is locked before its occupants are counted, so two requests for the same
-- location are decided one after the other. The pallet row is locked first, so two requests for the same pallet are too.
create function nexus.place(p_requester text, p_company uuid, p_source text, p_kind text, p_external_id text, p_to text, p_expected_from text, p_idem text) returns jsonb
language plpgsql set search_path to 'nexus' as $$
declare v_ext text := btrim(coalesce(p_external_id, '')); v_idem text := btrim(coalesce(p_idem, '')); m moves; p pallets; l locations; o occupancy; v_from locations; v_used int; r jsonb; v_seq bigint;
begin
  if p_kind not in ('assign', 'move', 'release') then return jsonb_build_object('ok', false, 'error', 'bad_request', 'message', 'kind is assign, move or release'); end if;
  if v_idem = '' or length(v_idem) > 128 then return jsonb_build_object('ok', false, 'error', 'bad_request', 'message', 'an idempotency key of 1 to 128 characters is required'); end if;
  if v_ext = '' or length(v_ext) > 64 then return jsonb_build_object('ok', false, 'error', 'bad_request', 'message', 'the pallet id is required'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_requester || chr(31) || v_idem, 0));   -- the same key twice at the same moment: one waits for the other's row
  select * into m from moves where requester = p_requester and idempotency_key = v_idem;
  if found then
    if m.kind <> p_kind or m.external_id <> v_ext then return jsonb_build_object('ok', false, 'error', 'idempotency_key_reused', 'message', 'this key was already used for a different request'); end if;
    return m.response || jsonb_build_object('replayed', true);
  end if;

  if p_kind = 'assign' then insert into pallets (company_id, source_system, external_id) values (p_company, p_source, v_ext) on conflict (company_id, external_id) do nothing; end if;
  select * into p from pallets where company_id = p_company and external_id = v_ext for update;
  if p.id is null then r := jsonb_build_object('ok', false, 'error', 'pallet_not_found', 'message', 'no pallet with that id for this company');
  else
    select * into o from occupancy where pallet_id = p.id;
    if o.pallet_id is not null then select * into v_from from locations where id = o.location_id; end if;
    if p_kind = 'assign' and o.pallet_id is not null then r := jsonb_build_object('ok', false, 'error', 'pallet_elsewhere', 'message', 'that pallet already stands in a location; move it instead', 'location', v_from.code);
    elsif p_kind in ('move', 'release') and o.pallet_id is null then r := jsonb_build_object('ok', false, 'error', 'pallet_not_placed', 'message', 'that pallet is not in any location');
    elsif p_kind in ('move', 'release') and nullif(btrim(coalesce(p_expected_from, '')), '') is not null and upper(btrim(p_expected_from)) <> v_from.code then
      r := jsonb_build_object('ok', false, 'error', 'pallet_elsewhere', 'message', 'the pallet is not where the request says it is', 'location', v_from.code);
    elsif p_kind = 'release' then
      delete from occupancy where pallet_id = p.id; update pallets set status = 'released' where id = p.id;
      insert into change_log (kind, company_id, location_id, pallet_id) values ('pallet_released', p_company, v_from.id, p.id) returning seq into v_seq;
      r := jsonb_build_object('ok', true, 'pallet', v_ext, 'released_from', v_from.code, 'seq', v_seq);
    else
      select * into l from locations where code = upper(btrim(coalesce(p_to, ''))) for update;   -- this lock is what makes capacity safe
      if l.id is null then r := jsonb_build_object('ok', false, 'error', 'location_not_found', 'message', 'no location with that code');
      elsif l.status = 'blocked' then r := jsonb_build_object('ok', false, 'error', 'location_blocked', 'message', coalesce(l.status_reason, 'that location is blocked'), 'location', l.code);
      elsif l.status = 'unavailable' then r := jsonb_build_object('ok', false, 'error', 'location_unavailable', 'message', coalesce(l.status_reason, 'that location is not in use'), 'location', l.code);
      elsif v_from.id = l.id then r := jsonb_build_object('ok', false, 'error', 'already_there', 'message', 'the pallet already stands there', 'location', l.code);
      else
        select count(*) into v_used from occupancy where location_id = l.id;
        if l.capacity is not null and v_used >= l.capacity then r := jsonb_build_object('ok', false, 'error', 'location_full', 'message', 'that location has no room', 'location', l.code, 'capacity', l.capacity, 'used', v_used);
        else
          insert into occupancy (pallet_id, location_id, placed_by) values (p.id, l.id, p_requester) on conflict (pallet_id) do update set location_id = excluded.location_id, since = now(), placed_by = excluded.placed_by;
          update pallets set status = 'active' where id = p.id and status <> 'active';
          insert into change_log (kind, company_id, location_id, pallet_id) values (case when p_kind = 'assign' then 'pallet_assigned' else 'pallet_moved' end, p_company, l.id, p.id) returning seq into v_seq;
          r := jsonb_build_object('ok', true, 'pallet', v_ext, 'location', l.code, 'from', v_from.code, 'seq', v_seq, 'free', case when l.capacity is not null then l.capacity - v_used - 1 end);
        end if;
      end if;
    end if;
  end if;
  insert into moves (kind, company_id, pallet_id, external_id, from_location, to_location, requester, idempotency_key, result, response)
  values (p_kind, p_company, p.id, v_ext, v_from.id, l.id, p_requester, v_idem, case when (r ->> 'ok')::boolean then 'ok' else r ->> 'error' end, r);
  return r;
end $$;

-- ───────── credentials ─────────
create function nexus.integration_create(p_actor text, p_company uuid, p_source text, p_scopes text[]) returns text language plpgsql set search_path to 'nexus' as $$
declare k text := 'nxk_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''); v_id uuid;
begin
  insert into integrations (company_id, source_system, key_hash, scopes) values (p_company, btrim(p_source), _hash(k), p_scopes) returning id into v_id;
  insert into audit_log (actor, action, target, after) values (p_actor, 'integration_created', v_id::text, jsonb_build_object('company', p_company, 'source_system', btrim(p_source), 'scopes', p_scopes));
  return k;   -- shown once; only the hash is kept
end $$;
-- who is calling. Company identity comes from the key and from nowhere else.
create function nexus._auth(p_key text, p_scope text, out integration_id uuid, out company_id uuid, out source_system text, out error jsonb) language plpgsql set search_path to 'nexus' as $$
declare i integrations;
begin
  select * into i from integrations where key_hash = _hash(p_key) and coalesce(p_key, '') <> '';
  if i.id is null or not i.active or not exists (select 1 from companies c where c.id = i.company_id and c.active) then error := jsonb_build_object('ok', false, 'error', 'unauthorized', 'message', 'unknown or inactive key'); return; end if;
  if not p_scope = any (i.scopes) then error := jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'this key does not have the ' || p_scope || ' scope'); return; end if;
  update integrations set last_ok_at = now() where id = i.id and (last_ok_at is null or last_ok_at < now() - interval '1 minute');
  integration_id := i.id; company_id := i.company_id; source_system := i.source_system;
end $$;

-- ───────── what a system may call (the HTTP layer maps onto these one to one) ─────────
create function nexus.api_place(p_key text, p_kind text, p_external_id text, p_to text, p_expected_from text, p_idem text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record;
begin
  select * into a from _auth(p_key, 'move'); if a.error is not null then return a.error; end if;
  return place('int:' || a.integration_id, a.company_id, a.source_system, p_kind, p_external_id, p_to, p_expected_from, p_idem);
end $$;
-- every location with how full it is and which companies stand there. A caller's own pallets are listed by id; another
-- company's are a name and a count, nothing more.
create function nexus.api_occupancy(p_key text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record;
begin
  select * into a from _auth(p_key, 'read'); if a.error is not null then return a.error; end if;
  return jsonb_build_object('ok', true, 'as_of', now(), 'locations', (select coalesce(jsonb_agg(jsonb_build_object('code', l.code, 'kind', l.kind, 'zone', l.zone, 'status', l.status, 'capacity', l.capacity,
      'used', (select count(*) from occupancy o where o.location_id = l.id), 'free', case when l.capacity is not null then l.capacity - (select count(*) from occupancy o where o.location_id = l.id) end,
      'occupants', (select coalesce(jsonb_agg(jsonb_build_object('company', c.code, 'pallets', x.n) order by c.code), '[]') from (select p.company_id, count(*) n from occupancy o join pallets p on p.id = o.pallet_id where o.location_id = l.id group by 1) x join companies c on c.id = x.company_id),
      'your_pallets', (select coalesce(jsonb_agg(p.external_id order by o.since), '[]') from occupancy o join pallets p on p.id = o.pallet_id where o.location_id = l.id and p.company_id = a.company_id),
      'updated_at', greatest(l.updated_at, (select max(o.since) from occupancy o where o.location_id = l.id))) order by l.code), '[]') from locations l));
end $$;
-- the feed: everything after p_after. Own changes carry the pallet id; another company's carry the company and location only.
create function nexus.api_changes(p_key text, p_after bigint default 0, p_limit integer default 200) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; v jsonb;
begin
  select * into a from _auth(p_key, 'read'); if a.error is not null then return a.error; end if;
  select coalesce(jsonb_agg(x.j order by x.seq), '[]') into v from (
    select g.seq, jsonb_build_object('seq', g.seq, 'at', g.at, 'kind', g.kind, 'v', g.schema_version, 'company', c.code, 'location', l.code)
      || case when g.company_id = a.company_id then jsonb_build_object('pallet', p.external_id) else '{}'::jsonb end j
    from change_log g left join companies c on c.id = g.company_id left join locations l on l.id = g.location_id left join pallets p on p.id = g.pallet_id
    where g.seq > coalesce(p_after, 0) order by g.seq limit least(greatest(coalesce(p_limit, 200), 1), 1000)) x;
  return jsonb_build_object('ok', true, 'changes', v, 'last', coalesce((select max((y ->> 'seq')::bigint) from jsonb_array_elements(v) y), coalesce(p_after, 0)));
end $$;
-- movement history of the caller's own pallets
create function nexus.api_moves(p_key text, p_external_id text default null, p_before bigint default null, p_limit integer default 200) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record;
begin
  select * into a from _auth(p_key, 'read'); if a.error is not null then return a.error; end if;
  return jsonb_build_object('ok', true, 'moves', (select coalesce(jsonb_agg(x.j order by x.id desc), '[]') from (
    select m.id, jsonb_build_object('id', m.id, 'at', m.at, 'kind', m.kind, 'pallet', m.external_id, 'from', f.code, 'to', t.code, 'result', m.result) j
    from moves m left join locations f on f.id = m.from_location left join locations t on t.id = m.to_location
    where m.company_id = a.company_id and (p_external_id is null or m.external_id = btrim(p_external_id)) and (p_before is null or m.id < p_before)
    order by m.id desc limit least(greatest(coalesce(p_limit, 200), 1), 1000)) x));
end $$;
-- admin: block, unblock or resize a location. A location is never set below what stands in it.
create function nexus.location_set(p_actor text, p_code text, p_status text, p_reason text, p_capacity integer) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare l locations; n locations; v_used int;
begin
  select * into l from locations where code = upper(btrim(coalesce(p_code, ''))) for update;
  if l.id is null then return jsonb_build_object('ok', false, 'error', 'location_not_found'); end if;
  select count(*) into v_used from occupancy where location_id = l.id;
  if p_capacity is not null and p_capacity < v_used then return jsonb_build_object('ok', false, 'error', 'capacity_below_occupancy', 'used', v_used); end if;
  update locations set status = coalesce(p_status, status), status_reason = case when coalesce(p_status, status) = 'open' then null else coalesce(nullif(btrim(p_reason), ''), status_reason) end,
    capacity = coalesce(p_capacity, capacity), updated_at = now(), updated_by = p_actor where id = l.id returning * into n;
  insert into audit_log (actor, action, target, before, after) values (p_actor, 'location_changed', l.code, jsonb_build_object('status', l.status, 'capacity', l.capacity), jsonb_build_object('status', n.status, 'capacity', n.capacity, 'reason', n.status_reason));
  insert into change_log (kind, location_id) values ('location_changed', l.id);
  return jsonb_build_object('ok', true, 'code', n.code, 'status', n.status, 'capacity', n.capacity);
end $$;
