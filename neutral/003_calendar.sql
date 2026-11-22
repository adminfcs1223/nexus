-- Shared dock calendar. Each company's own system stays the owner of its events: it sends them here and only it can change
-- them. The other company sees who, which way, when, how many pallets and the status. The reference and note are the owner's.
create table nexus.calendar_events (
  id uuid primary key default gen_random_uuid(), warehouse text not null references nexus.warehouses(code), company_id uuid not null references nexus.companies(id),
  source_system text not null, external_id text not null check (length(btrim(external_id)) between 1 and 64),
  direction text not null check (direction in ('inbound', 'outbound')), starts_at timestamptz not null, ends_at timestamptz check (ends_at is null or ends_at >= starts_at),
  pallets integer check (pallets >= 0), status text not null default 'scheduled' check (status in ('scheduled', 'arrived', 'completed', 'cancelled')),
  private_ref text check (length(private_ref) <= 120), private_note text check (length(private_note) <= 500),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (warehouse, company_id, external_id));
create index calendar_when on nexus.calendar_events (warehouse, starts_at);

-- create or change one of the caller's own events, keyed by the id its own system gives it. Sending it twice changes nothing.
create function nexus.api_calendar_put(p_key text, p_external_id text, p_body jsonb) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record; e calendar_events; n calendar_events; v_ext text := btrim(coalesce(p_external_id, '')); b jsonb := coalesce(p_body, '{}'); v_new boolean;
begin
  select * into a from _auth(p_key, 'calendar'); if a.error is not null then return a.error; end if;
  if v_ext = '' or length(v_ext) > 64 then return jsonb_build_object('ok', false, 'error', 'bad_request', 'message', 'the event id is required'); end if;
  select * into e from calendar_events where warehouse = a.warehouse and company_id = a.company_id and external_id = v_ext for update;
  v_new := e.id is null;
  begin
    if v_new then
      insert into calendar_events (warehouse, company_id, source_system, external_id, direction, starts_at, ends_at, pallets, status, private_ref, private_note)
      values (a.warehouse, a.company_id, a.source_system, v_ext, b ->> 'direction', (b ->> 'starts_at')::timestamptz, (b ->> 'ends_at')::timestamptz, (b ->> 'pallets')::integer,
        coalesce(b ->> 'status', 'scheduled'), b ->> 'reference', b ->> 'note') returning * into n;
    else
      update calendar_events set direction = coalesce(b ->> 'direction', direction), starts_at = coalesce((b ->> 'starts_at')::timestamptz, starts_at),
        ends_at = case when b ? 'ends_at' then (b ->> 'ends_at')::timestamptz else ends_at end, pallets = case when b ? 'pallets' then (b ->> 'pallets')::integer else pallets end,
        status = coalesce(b ->> 'status', status), private_ref = case when b ? 'reference' then b ->> 'reference' else private_ref end,
        private_note = case when b ? 'note' then b ->> 'note' else private_note end where id = e.id returning * into n;
    end if;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'bad_request', 'message', 'direction is inbound or outbound; starts_at is a date and time with its offset; pallets is a whole number; status is scheduled, arrived, completed or cancelled');
  end;
  if not v_new and (n.direction, n.starts_at, n.ends_at, n.pallets, n.status, n.private_ref, n.private_note) is not distinct from (e.direction, e.starts_at, e.ends_at, e.pallets, e.status, e.private_ref, e.private_note)
    then return jsonb_build_object('ok', true, 'event', v_ext, 'changed', false); end if;
  update calendar_events set updated_at = now() where id = n.id;
  insert into change_log (warehouse, kind, company_id, event_ref) values (a.warehouse, case when v_new then 'calendar_added' when n.status = 'cancelled' then 'calendar_cancelled' else 'calendar_changed' end, a.company_id, v_ext);
  return jsonb_build_object('ok', true, 'event', v_ext, 'changed', true, 'created', v_new, 'status', n.status);
end $$;

-- everything on the dock calendar between two moments, both companies. Another company's events carry the shared fields only.
create function nexus.api_calendar(p_key text, p_from timestamptz default null, p_to timestamptz default null) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare a record;
begin
  select * into a from _auth(p_key, 'read'); if a.error is not null then return a.error; end if;
  return jsonb_build_object('ok', true, 'warehouse', a.warehouse, 'events', (select coalesce(jsonb_agg(
      jsonb_build_object('company', c.code, 'direction', e.direction, 'starts_at', e.starts_at, 'ends_at', e.ends_at, 'pallets', e.pallets, 'status', e.status, 'updated_at', e.updated_at, 'mine', e.company_id = a.company_id)
      || case when e.company_id = a.company_id then jsonb_build_object('id', e.external_id, 'reference', e.private_ref, 'note', e.private_note) else '{}'::jsonb end
      order by e.starts_at, c.code, e.external_id), '[]')
    from calendar_events e join companies c on c.id = e.company_id
    where e.warehouse = a.warehouse and e.starts_at >= coalesce(p_from, now() - interval '1 day') and e.starts_at < coalesce(p_to, now() + interval '60 days')));
end $$;
