-- Nexus v2 (Derek, 2026-11-21). APPLIED TO PRODUCTION 2026-11-21 (evening), in one transaction with a read-only self-test.
-- Floor controls (move a pallet, override what a WMS entered, everything about a position), the label register (Nexus is the
-- label source: every pallet and carton label is recorded the moment it is made), Receiving in Nexus (list, label data, complete),
-- connections with two keys (floor window / admin window) and per-connection permissions, and calendar edits.
-- Additive: new tables, new columns on nexus_clients, new functions, two triggers that can never block receiving.
-- One existing function is replaced: _nexus_api_client (so the read API accepts either key of a connection).
-- For reference; do not re-run. Undo: 20261121_nexus_v2.rollback.sql.
begin;

-- ───────── tables ─────────
create table public.nexus_moves (              -- every floor change made through Nexus: who, what, from where to where, why
  id bigserial primary key, at timestamptz not null default now(), pallet_id uuid references public.wms_pallets(id), psku text, org_id uuid,
  action text not null check (action in ('move', 'putaway', 'edit', 'void', 'position_add', 'position_edit', 'received')),
  from_code text, to_code text, changes jsonb, reason text, actor uuid, actor_name text, source text not null default 'Nexus');
create index nexus_moves_pallet on public.nexus_moves (pallet_id, id desc);
create table public.nexus_labels (             -- the label register: one row per label, with what is printed on it
  id bigserial primary key, kind text not null check (kind in ('pallet', 'carton', 'unit', 'position')), code text not null,
  org_id uuid, pallet_id uuid, sku_id uuid, item_no text, item_name text, content jsonb not null default '{}',
  source text not null default 'ShipBay WMS', made_by uuid, made_by_name text, made_at timestamptz not null default now(),
  prints integer not null default 0, last_printed_at timestamptz, unique (kind, code));
create index nexus_labels_pallet on public.nexus_labels (pallet_id); create index nexus_labels_org on public.nexus_labels (org_id, id desc);
alter table public.nexus_moves enable row level security; alter table public.nexus_labels enable row level security;
revoke all on public.nexus_moves, public.nexus_labels from public, anon, authenticated, service_role;
revoke all on sequence public.nexus_moves_id_seq, public.nexus_labels_id_seq from public, anon, authenticated, service_role;

-- a connection has two keys: key_hash = the floor window, admin_key_hash = the admin window; perms says what each may do
alter table public.nexus_clients add column if not exists admin_key_hash text unique;
alter table public.nexus_clients add column if not exists perms jsonb not null default '{"floor":{"map":true,"scan":true,"brands":true},"admin":{"map":true,"scan":true,"brands":true,"calendar":true,"labels":true}}';
alter table public.nexus_clients add column if not exists admin_last_used_at timestamptz;

create function public._nexus_who() returns text language sql stable security definer set search_path to 'public' as $$ select coalesce(full_name, email) from profiles where id = auth.uid() $$;
revoke all on function public._nexus_who() from public, anon, authenticated, service_role;

-- ───────── label register: filled by the database itself, so no WMS can make a label Nexus does not hold ─────────
create function public._nexus_label_trg() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_src text := coalesce(nullif(current_setting('nexus.source', true), ''), 'ShipBay WMS');
begin
  begin
    if tg_table_name = 'wms_cartons' then   -- checked first: a carton row has no label_prints to compare
      if not new.cle then
      insert into nexus_labels (kind, code, org_id, pallet_id, sku_id, item_no, item_name, content, source, made_by, made_by_name)
      values ('carton', new.code, new.org_id, new.pallet_id, new.sku_id, new.item_no, new.item_name,
        jsonb_build_object('brand', (select name from orgs where id = new.org_id), 'pallet', (select psku from wms_pallets where id = new.pallet_id), 'carton', new.seq,
          'item', new.item_name, 'item_no', new.item_no, 'units_per_carton', new.units_per_carton, 'fba', new.fba),
        v_src, auth.uid(), _nexus_who()) on conflict (kind, code) do nothing;
      end if;
    elsif tg_op = 'INSERT' then
      insert into nexus_labels (kind, code, org_id, pallet_id, sku_id, item_no, item_name, content, source, made_by, made_by_name, made_at)
      values ('pallet', new.psku, new.org_id, new.id, new.sku_id, new.item_no, new.item_name,
        jsonb_build_object('size', '4x6', 'brand', (select name from orgs where id = new.org_id), 'psku', new.psku, 'item', new.item_name, 'item_no', new.item_no,
          'cartons', new.cartons, 'units_per_carton', new.units_per_carton, 'mixed', new.mixed, 'fba', new.fba, 'ncc', new.cle, 'reference', new.reference, 'received_at', new.received_at),
        v_src, new.received_by, new.received_by_name, new.received_at) on conflict (kind, code) do nothing;
    elsif coalesce(new.label_prints, 0) > coalesce(old.label_prints, 0) then
      update nexus_labels set prints = new.label_prints, last_printed_at = new.last_printed_at where kind = 'pallet' and code = new.psku;
    end if;
  exception when others then null;   -- the register must never stop a receipt
  end;
  return null;
end $$;
revoke all on function public._nexus_label_trg() from public, anon, authenticated, service_role;
create trigger nexus_label_pallet after insert or update of label_prints on public.wms_pallets for each row execute function public._nexus_label_trg();
create trigger nexus_label_carton after insert on public.wms_cartons for each row execute function public._nexus_label_trg();
-- labels made before today
insert into public.nexus_labels (kind, code, org_id, pallet_id, sku_id, item_no, item_name, content, made_by, made_by_name, made_at, prints, last_printed_at)
select 'pallet', p.psku, p.org_id, p.id, p.sku_id, p.item_no, p.item_name, jsonb_build_object('size', '4x6', 'brand', g.name, 'psku', p.psku, 'item', p.item_name, 'item_no', p.item_no, 'cartons', p.cartons,
  'units_per_carton', p.units_per_carton, 'mixed', p.mixed, 'fba', p.fba, 'ncc', p.cle, 'reference', p.reference, 'received_at', p.received_at), p.received_by, p.received_by_name, p.received_at, p.label_prints, p.last_printed_at
from public.wms_pallets p join public.orgs g on g.id = p.org_id on conflict do nothing;
insert into public.nexus_labels (kind, code, org_id, pallet_id, sku_id, item_no, item_name, content, made_at)
select 'carton', c.code, c.org_id, c.pallet_id, c.sku_id, c.item_no, c.item_name, jsonb_build_object('brand', g.name, 'pallet', p.psku, 'carton', c.seq, 'item', c.item_name, 'item_no', c.item_no, 'units_per_carton', c.units_per_carton, 'fba', c.fba), p.received_at
from public.wms_cartons c join public.wms_pallets p on p.id = c.pallet_id join public.orgs g on g.id = c.org_id where not c.cle on conflict do nothing;

create function public.nexus_labels_list(p_org uuid default null, p_kind text default null, p_q text default null, p_limit integer default 300) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform 1 from _nexus_staff();
  return (select coalesce(jsonb_agg(x), '[]') from (
    select jsonb_build_object('id', n.id, 'kind', n.kind, 'code', n.code, 'brand', g.name, 'pallet', p.psku, 'position', l.code, 'item', n.item_name, 'item_no', n.item_no,
      'source', n.source, 'made_by', n.made_by_name, 'made_at', n.made_at, 'prints', n.prints, 'last_printed_at', n.last_printed_at, 'content', n.content) x
    from nexus_labels n left join orgs g on g.id = n.org_id left join wms_pallets p on p.id = n.pallet_id left join locations l on l.id = p.location_id
    where (p_org is null or n.org_id = p_org) and (coalesce(p_kind, '') = '' or n.kind = p_kind)
      and (coalesce(btrim(p_q), '') = '' or n.code ilike '%' || btrim(p_q) || '%' or n.item_name ilike '%' || btrim(p_q) || '%' or n.item_no ilike '%' || btrim(p_q) || '%' or p.psku ilike '%' || btrim(p_q) || '%')
    order by n.made_at desc, n.id desc limit least(greatest(coalesce(p_limit, 300), 1), 1000)) s);
end $$;
-- a label printed from Nexus (position labels today): written to the register with its print count
create function public.nexus_labels_printed(p_kind text, p_codes text[]) returns integer language plpgsql security definer set search_path to 'public' as $$
declare c record; n integer;
begin
  select * into c from _nexus_staff();
  if p_kind not in ('position', 'pallet', 'carton', 'unit') or coalesce(cardinality(p_codes), 0) = 0 or cardinality(p_codes) > 500 then raise exception 'Nothing to record.'; end if;
  if p_kind = 'position' then
    insert into nexus_labels (kind, code, content, source, made_by, made_by_name, prints, last_printed_at)
    select 'position', l.code, jsonb_build_object('size', '4x6', 'code', l.code, 'zone', l.zone, 'barcode', 'LOC-' || l.code), 'Nexus', c.uid, c.who, 1, now() from locations l where l.code = any(p_codes)
    on conflict (kind, code) do update set prints = nexus_labels.prints + 1, last_printed_at = now();
  elsif p_kind = 'pallet' then update wms_pallets set label_prints = label_prints + 1, last_printed_at = now() where psku = any(p_codes) and status <> 'void';   -- the trigger carries it into the register
  else update nexus_labels set prints = prints + 1, last_printed_at = now() where kind = p_kind and code = any(p_codes);
  end if;
  get diagnostics n = row_count; return n;
end $$;

-- ───────── Floor: move, override, void ─────────
create function public.nexus_move_pallet(p_psku text, p_location text, p_reason text default null, p_store boolean default false) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare c record; p wms_pallets; l locations; v_from text; v_loc text := upper(regexp_replace(btrim(coalesce(p_location, '')), '^LOC-', '', 'i')); v_store boolean;
begin
  select * into c from _nexus_staff();
  if c.role not in ('shipbay_admin', 'shipbay_staff') then raise exception 'Only a Nexus admin or staff login can move a pallet from here.'; end if;
  select * into p from wms_pallets where upper(psku) = upper(btrim(coalesce(p_psku, ''))) for update;
  if p.id is null then raise exception 'Pallet % is not on file.', coalesce(nullif(btrim(p_psku), ''), '(blank)'); end if;
  if p.status = 'void' then raise exception '% was voided.', p.psku; end if;
  select * into l from locations where upper(code) = v_loc and active;
  if l.id is null or l.kind not in ('pallet', 'floor') then raise exception 'Position % is not a pallet position.', coalesce(nullif(v_loc, ''), '(blank)'); end if;
  if l.id is not distinct from p.location_id and (p.status = 'stored' or not p_store) then raise exception '% is already at %.', p.psku, l.code; end if;
  if l.kind = 'pallet' and exists (select 1 from wms_pallets x where x.location_id = l.id and x.status in ('counted', 'stored') and x.id <> p.id) then raise exception 'Position % already holds a pallet.', l.code; end if;
  v_store := p_store and p.status <> 'stored';
  if v_store and p.held then raise exception '% is on HOLD (%): release it before it is put away.', p.psku, coalesce(p.hold_reason, 'no reason given'); end if;
  select code into v_from from locations where id = p.location_id;
  if v_store then update wms_pallets set location_id = l.id, status = 'stored', stored_at = now(), stored_by_name = c.who, counted_at = coalesce(counted_at, now()), counted_by_name = coalesce(counted_by_name, c.who) where id = p.id;
  else update wms_pallets set location_id = l.id where id = p.id; end if;
  insert into nexus_moves (pallet_id, psku, org_id, action, from_code, to_code, reason, actor, actor_name)
  values (p.id, p.psku, p.org_id, case when v_store then 'putaway' else 'move' end, v_from, l.code, nullif(btrim(p_reason), ''), c.uid, c.who);
  return jsonb_build_object('psku', p.psku, 'from', v_from, 'to', l.code, 'stored', v_store or p.status = 'stored');
end $$;

-- override what a WMS entered. Only the named fields; every change is logged old -> new with the reason.
create function public.nexus_pallet_edit(p_psku text, p_changes jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare c record; p wms_pallets; n wms_pallets; k text; v_log jsonb := '{}';
begin
  select * into c from _nexus_staff();
  if c.role <> 'shipbay_admin' then raise exception 'Only a Nexus admin can change a pallet''s details.'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why this is being changed.'; end if;
  select * into p from wms_pallets where upper(psku) = upper(btrim(coalesce(p_psku, ''))) for update;
  if p.id is null or p.status = 'void' then raise exception 'That pallet is not on file.'; end if;
  for k in select jsonb_object_keys(coalesce(p_changes, '{}')) loop
    if k not in ('cartons', 'units_total', 'units_per_carton', 'item_name', 'notes', 'reference', 'carrier', 'fba') then raise exception '"%" cannot be changed from Nexus.', k; end if;
  end loop;
  if (p_changes ? 'cartons' and coalesce((p_changes ->> 'cartons')::int, -1) not between 0 and 5000) or (p_changes ? 'units_total' and coalesce((p_changes ->> 'units_total')::int, -1) not between 0 and 1000000)
    or (p_changes ? 'units_per_carton' and coalesce((p_changes ->> 'units_per_carton')::int, -1) not between 0 and 100000) then raise exception 'Check the numbers.'; end if;
  update wms_pallets set
    cartons = case when p_changes ? 'cartons' then (p_changes ->> 'cartons')::int else cartons end,
    units_total = case when p_changes ? 'units_total' then (p_changes ->> 'units_total')::int else units_total end,
    units_per_carton = case when p_changes ? 'units_per_carton' then (p_changes ->> 'units_per_carton')::int else units_per_carton end,
    item_name = case when p_changes ? 'item_name' then nullif(btrim(p_changes ->> 'item_name'), '') else item_name end,
    notes = case when p_changes ? 'notes' then nullif(btrim(p_changes ->> 'notes'), '') else notes end,
    reference = case when p_changes ? 'reference' then nullif(btrim(p_changes ->> 'reference'), '') else reference end,
    carrier = case when p_changes ? 'carrier' then nullif(btrim(p_changes ->> 'carrier'), '') else carrier end,
    fba = case when p_changes ? 'fba' then (p_changes ->> 'fba')::boolean else fba end
  where id = p.id returning * into n;
  for k in select jsonb_object_keys(p_changes) loop
    if to_jsonb(p) -> k is distinct from to_jsonb(n) -> k then v_log := v_log || jsonb_build_object(k, jsonb_build_object('from', to_jsonb(p) -> k, 'to', to_jsonb(n) -> k)); end if;
  end loop;
  if v_log = '{}' then raise exception 'Nothing was different.'; end if;
  insert into nexus_moves (pallet_id, psku, org_id, action, changes, reason, actor, actor_name) values (p.id, p.psku, p.org_id, 'edit', v_log, btrim(p_reason), c.uid, c.who);
  return v_log;
end $$;
create function public.nexus_pallet_void(p_psku text, p_reason text) returns void language plpgsql security definer set search_path to 'public' as $$
declare c record; p wms_pallets;
begin
  select * into c from _nexus_staff();
  if c.role <> 'shipbay_admin' then raise exception 'Only a Nexus admin can void a pallet.'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why this pallet is being voided.'; end if;
  select * into p from wms_pallets where upper(psku) = upper(btrim(coalesce(p_psku, ''))) for update;
  if p.id is null or p.status = 'void' then raise exception 'That pallet is not on file or is already voided.'; end if;
  update wms_pallets set status = 'void', voided_at = now(), voided_by = c.uid, void_reason = btrim(p_reason) where id = p.id;
  insert into nexus_moves (pallet_id, psku, org_id, action, from_code, reason, actor, actor_name) values (p.id, p.psku, p.org_id, 'void', (select code from locations where id = p.location_id), btrim(p_reason), c.uid, c.who);
end $$;

create function public._nexus_history(p_pallet uuid, p_code text, p_limit integer) returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(x order by (x ->> 'at') desc), '[]') from (
    select * from (select jsonb_build_object('at', m.at, 'psku', m.psku, 'brand', g.name, 'action', m.action, 'from', m.from_code, 'to', m.to_code, 'changes', m.changes, 'reason', m.reason, 'by', m.actor_name, 'source', m.source) x
      from nexus_moves m left join orgs g on g.id = m.org_id
      where (p_pallet is null or m.pallet_id = p_pallet) and (p_code is null or p_code in (m.from_code, m.to_code)) order by m.id desc limit p_limit) a
    union all
    select * from (select jsonb_build_object('at', a.at, 'psku', a.ref, 'brand', g.name, 'action', a.kind, 'to', a.detail ->> 'location', 'by', a.actor_name, 'source', 'WMS') x
      from wms_activity a left join orgs g on g.id = a.org_id
      where a.kind in ('pallet_received', 'pallet_counted', 'pallet_putaway', 'pallet_voided', 'pallet_hold', 'pallet_label_print')
        and (p_pallet is null or a.ref = (select psku from wms_pallets where id = p_pallet)) and (p_code is null or a.detail ->> 'location' = p_code) order by a.id desc limit p_limit) b) u;
$$;
revoke all on function public._nexus_history(uuid, text, integer) from public, anon, authenticated, service_role;
create function public.nexus_floor_log(p_limit integer default 100) returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin perform 1 from _nexus_staff(); return _nexus_history(null, null, least(greatest(coalesce(p_limit, 100), 1), 500)); end $$;

create function public.nexus_pallet_detail(p_psku text) returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare p wms_pallets;
begin
  perform 1 from _nexus_staff();
  select * into p from wms_pallets where upper(psku) = upper(btrim(coalesce(p_psku, '')));
  if p.id is null then raise exception 'Pallet not on file.'; end if;
  return jsonb_build_object('psku', p.psku, 'brand', (select name from orgs where id = p.org_id), 'org_id', p.org_id, 'status', p.status, 'held', p.held, 'hold_reason', p.hold_reason,
    'position', (select code from locations where id = p.location_id), 'zone', (select zone from locations where id = p.location_id),
    'item', p.item_name, 'item_no', p.item_no, 'sku', (select sku from skus where id = p.sku_id), 'mixed', p.mixed, 'fba', p.fba, 'ncc', p.cle,
    'cartons', p.cartons, 'units_per_carton', p.units_per_carton, 'units_total', p.units_total, 'reference', p.reference, 'carrier', p.carrier, 'notes', p.notes,
    'booking', (select reference from inbound_shipments where id = p.inbound_id),
    'received_at', p.received_at, 'received_by', p.received_by_name, 'counted_at', p.counted_at, 'counted_by', p.counted_by_name, 'stored_at', p.stored_at, 'stored_by', p.stored_by_name,
    'void_reason', p.void_reason, 'voided_at', p.voided_at, 'label_prints', p.label_prints, 'last_printed_at', p.last_printed_at,
    'on_hand', (select coalesce(sum(qty), 0) from inventory_moves where ref_type = 'wms_pallet' and ref_id = p.id),
    'cartons_made', (select count(*) from wms_cartons where pallet_id = p.id), 'cartons_scanned', (select count(*) from wms_cartons where pallet_id = p.id and scanned_at is not null),
    'carton_list', (select coalesce(jsonb_agg(jsonb_build_object('code', k.code, 'seq', k.seq, 'item', k.item_name, 'units', k.units_per_carton, 'scanned_at', k.scanned_at, 'open_box', k.open_box_at is not null) order by k.seq), '[]')
                    from (select * from wms_cartons where pallet_id = p.id order by seq limit 600) k),
    'labels', (select coalesce(jsonb_agg(jsonb_build_object('kind', n.kind, 'code', n.code, 'prints', n.prints, 'made_at', n.made_at, 'source', n.source, 'last_printed_at', n.last_printed_at) order by n.kind desc, n.code), '[]')
               from (select * from nexus_labels where pallet_id = p.id order by kind desc, code limit 600) n),
    'history', _nexus_history(p.id, null, 100));
end $$;

create function public.nexus_position_detail(p_code text) returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare l locations;
begin
  perform 1 from _nexus_staff();
  select * into l from locations where upper(code) = upper(btrim(coalesce(p_code, '')));
  if l.id is null then raise exception 'Position not on file.'; end if;
  return jsonb_build_object('code', l.code, 'zone', l.zone, 'kind', l.kind, 'active', l.active, 'created_at', l.created_at,
    'label', (select jsonb_build_object('prints', n.prints, 'last_printed_at', n.last_printed_at) from nexus_labels n where n.kind = 'position' and n.code = l.code),
    'pallets', (select coalesce(jsonb_agg(jsonb_build_object('psku', v.psku, 'brand', v.org_name, 'item', v.item_name, 'item_no', v.item_no, 'status', v.status, 'held', v.held, 'cartons', v.cartons, 'units', v.units_total,
        'received_at', v.received_at, 'stored_at', v.stored_at, 'age_days', v.age_days, 'label_prints', v.label_prints, 'last_printed_at', v.last_printed_at,
        'reference', w.reference, 'carrier', w.carrier, 'notes', w.notes, 'fba', w.fba,
        'on_hand', (select coalesce(sum(m.qty), 0) from inventory_moves m where m.ref_type = 'wms_pallet' and m.ref_id = v.id),
        'carton_labels', (select count(*) from nexus_labels n where n.pallet_id = v.id and n.kind = 'carton')) order by v.received_at), '[]') from v_nexus_pallets v join wms_pallets w on w.id = v.id where v.location_id = l.id),
    'history', _nexus_history(null, l.code, 40));
end $$;
create function public.nexus_position_edit(p_code text, p_zone text, p_active boolean) returns void language plpgsql security definer set search_path to 'public' as $$
declare c record; l locations;
begin
  select * into c from _nexus_staff();
  if c.role <> 'shipbay_admin' then raise exception 'Only a Nexus admin can change a position.'; end if;
  select * into l from locations where upper(code) = upper(btrim(coalesce(p_code, ''))) for update;
  if l.id is null or l.kind not in ('pallet', 'floor') then raise exception 'Position not on file.'; end if;
  if not p_active and exists (select 1 from wms_pallets x where x.location_id = l.id and x.status <> 'void') then raise exception 'Move the pallet off % before turning it off.', l.code; end if;
  update locations set zone = nullif(btrim(p_zone), ''), active = p_active where id = l.id;
  insert into nexus_moves (action, to_code, changes, actor, actor_name) values ('position_edit', l.code, jsonb_build_object('zone', jsonb_build_object('from', l.zone, 'to', nullif(btrim(p_zone), '')), 'active', jsonb_build_object('from', l.active, 'to', p_active)), c.uid, c.who);
end $$;
-- positions an admin turned off (they leave the map; this is how they come back)
create function public.nexus_positions_off() returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin perform 1 from _nexus_staff(); return (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'zone', zone) order by code), '[]') from locations where not active and kind in ('pallet', 'floor')); end $$;

create function public.nexus_dashboard() returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare d timestamptz := date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York';
begin
  perform 1 from _nexus_staff();
  return jsonb_build_object(
    'labels_today', (select count(*) from nexus_labels where made_at >= d), 'labels_total', (select count(*) from nexus_labels),
    'moves_today', (select count(*) from nexus_moves where at >= d and action in ('move', 'putaway')),
    'received_today', (select count(*) from v_nexus_pallets where received_at >= d),
    'oldest_days', (select max(age_days) from v_nexus_pallets where status = 'stored'),
    'waiting', (select coalesce(jsonb_agg(jsonb_build_object('psku', v.psku, 'brand', v.org_name, 'item', v.item_name, 'status', v.status, 'held', v.held, 'received_at', v.received_at, 'position', v.location_code) order by v.received_at), '[]')
                from (select * from v_nexus_pallets where status <> 'stored' order by received_at limit 12) v),
    'log', _nexus_history(null, null, 8));
end $$;

-- ───────── calendar: change or cancel a booked shipment ─────────
create function public.nexus_shipment_update(p_id uuid, p_expected date, p_pallets integer, p_cartons integer, p_origin text, p_notes text, p_cancel boolean default false) returns void
language plpgsql security definer set search_path to 'public' as $$
declare c record; i inbound_shipments;
begin
  select * into c from _nexus_staff();
  if c.role not in ('shipbay_admin', 'shipbay_staff') then raise exception 'Only ShipBay admin or staff can change a shipment.'; end if;
  select * into i from inbound_shipments where id = p_id for update;
  if i.id is null or i.status = 'cancelled' then raise exception 'Shipment not on file.'; end if;
  if p_cancel then
    if exists (select 1 from wms_pallets where inbound_id = i.id and status <> 'void') then raise exception 'Pallets were already received against this shipment. It cannot be cancelled.'; end if;
    update inbound_shipments set status = 'cancelled' where id = i.id; return;
  end if;
  if p_expected is null or coalesce(p_pallets, 0) < 1 or p_pallets > 200 then raise exception 'An expected date and 1 to 200 pallets are needed.'; end if;
  update inbound_shipments set expected_at = p_expected, pallets = p_pallets, cartons = coalesce(p_cartons, 0), origin = nullif(btrim(p_origin), ''), notes = nullif(btrim(p_notes), ''),
    approved_at = coalesce(approved_at, now()), approved_by = coalesce(approved_by, c.uid), approved_by_name = coalesce(approved_by_name, c.who) where id = i.id;
end $$;

-- ───────── connections: two keys and permissions ─────────
create function public._nexus_newkey() returns text language sql as $$ select 'nxs_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') $$;
create function public._nexus_hash(p text) returns text language sql immutable as $$ select encode(sha256(convert_to(coalesce(p, ''), 'utf8')), 'hex') $$;
revoke all on function public._nexus_newkey(), public._nexus_hash(text) from public, anon, authenticated, service_role;
create function public._nexus_perms(p jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'floor', jsonb_build_object('map', coalesce((p #>> '{floor,map}')::boolean, true), 'scan', coalesce((p #>> '{floor,scan}')::boolean, true), 'brands', coalesce((p #>> '{floor,brands}')::boolean, true)),
    'admin', jsonb_build_object('map', coalesce((p #>> '{admin,map}')::boolean, true), 'scan', coalesce((p #>> '{admin,scan}')::boolean, true), 'brands', coalesce((p #>> '{admin,brands}')::boolean, true),
      'calendar', coalesce((p #>> '{admin,calendar}')::boolean, true), 'labels', coalesce((p #>> '{admin,labels}')::boolean, true)))
$$;
revoke all on function public._nexus_perms(jsonb) from public, anon, authenticated, service_role;
create function public.nexus_connections_list() returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare c record;
begin
  select * into c from _nexus_staff();
  if c.role <> 'shipbay_admin' then raise exception 'Only a Nexus admin can see connections.'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'name', n.name, 'active', n.active, 'org_ids', n.org_ids, 'brands', (select coalesce(jsonb_agg(g.name order by g.name), '[]') from orgs g where g.id = any(n.org_ids)),
    'perms', _nexus_perms(n.perms), 'has_admin_key', n.admin_key_hash is not null, 'floor_used_at', n.last_used_at, 'admin_used_at', n.admin_last_used_at, 'created_at', n.created_at) order by n.created_at), '[]') from nexus_clients n);
end $$;
-- p_id null = a new connection (both keys are returned once); otherwise name / brands / permissions are changed and no key is touched
create function public.nexus_connection_save(p_id uuid, p_name text, p_org_ids uuid[], p_perms jsonb) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare c record; v_id uuid; kf text; ka text;
begin
  select * into c from _nexus_staff();
  if c.role <> 'shipbay_admin' then raise exception 'Only a Nexus admin can change a connection.'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'Name the connection.'; end if;
  if coalesce(cardinality(p_org_ids), 0) = 0 or (select count(*) from orgs where id = any(p_org_ids)) is distinct from cardinality(p_org_ids) then raise exception 'Pick the brands this connection may see.'; end if;
  if p_id is null then
    kf := _nexus_newkey(); ka := _nexus_newkey();
    insert into nexus_clients (name, org_ids, key_hash, admin_key_hash, perms, created_by) values (btrim(p_name), p_org_ids, _nexus_hash(kf), _nexus_hash(ka), _nexus_perms(p_perms), c.uid) returning id into v_id;
    return jsonb_build_object('id', v_id, 'floor_key', kf, 'admin_key', ka);
  end if;
  update nexus_clients set name = btrim(p_name), org_ids = p_org_ids, perms = _nexus_perms(p_perms) where id = p_id returning id into v_id;
  if v_id is null then raise exception 'Connection not on file.'; end if;
  return jsonb_build_object('id', v_id);
end $$;
-- a fresh key for one window; the old one stops working at once
create function public.nexus_connection_new_key(p_id uuid, p_access text) returns text language plpgsql security definer set search_path to 'public' as $$
declare c record; k text := _nexus_newkey(); n integer;
begin
  select * into c from _nexus_staff();
  if c.role <> 'shipbay_admin' then raise exception 'Only a Nexus admin can make a key.'; end if;
  if p_access = 'floor' then update nexus_clients set key_hash = _nexus_hash(k) where id = p_id;
  elsif p_access = 'admin' then update nexus_clients set admin_key_hash = _nexus_hash(k) where id = p_id;
  else raise exception 'Floor key or admin key.'; end if;
  get diagnostics n = row_count; if n = 0 then raise exception 'Connection not on file.'; end if;
  return k;
end $$;

-- which connection a key belongs to, which window it opens, and what that window may do
create function public._nexus_api_auth(p_key text, out client_id uuid, out name text, out org_ids uuid[], out access text, out can jsonb) language plpgsql security definer set search_path to 'public' as $$
declare n nexus_clients; h text := _nexus_hash(p_key);
begin
  select * into n from nexus_clients k where k.key_hash = h or k.admin_key_hash = h;
  if n.id is null or not n.active or coalesce(p_key, '') = '' then raise exception 'Unknown or inactive Nexus key.'; end if;
  access := case when n.admin_key_hash = h then 'admin' else 'floor' end;
  if access = 'admin' then update nexus_clients set admin_last_used_at = now() where id = n.id and (admin_last_used_at is null or admin_last_used_at < now() - interval '1 minute');
  else update nexus_clients set last_used_at = now() where id = n.id and (last_used_at is null or last_used_at < now() - interval '1 minute'); end if;
  client_id := n.id; name := n.name; org_ids := n.org_ids; can := _nexus_perms(n.perms) -> access;
end $$;
revoke all on function public._nexus_api_auth(text) from public, anon, authenticated, service_role;
create or replace function public._nexus_api_client(p_key text) returns uuid[] language plpgsql security definer set search_path to 'public' as $$
begin return (select a.org_ids from _nexus_api_auth(p_key) a); end $$;

-- ───────── the two windows (key only, no login). A window sees its own brands; other brands' positions show only as taken. ─────────
create function public.nexus_api_window(p_key text) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare a record;
begin
  select * into a from _nexus_api_auth(p_key);
  return jsonb_build_object('name', a.name, 'access', a.access, 'can', a.can, 'brands', (select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) order by g.name), '[]') from orgs g where g.id = any(a.org_ids)));
end $$;
create function public.nexus_api_floor(p_key text) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare a record;
begin
  select * into a from _nexus_api_auth(p_key);
  if not (a.can ->> 'map')::boolean then raise exception 'This key cannot see the floor.'; end if;
  return jsonb_build_object('as_of', now(),
    'positions', (select coalesce(jsonb_agg(jsonb_build_object('code', l.code, 'kind', l.kind, 'zone', l.zone,
        'taken', exists (select 1 from v_nexus_pallets v where v.location_id = l.id),
        'pallets', (select coalesce(jsonb_agg(jsonb_build_object('psku', v.psku, 'brand', v.org_name, 'item', v.item_name, 'status', v.status, 'held', v.held, 'cartons', v.cartons, 'units', v.units_total,
            'received_at', v.received_at, 'age_days', v.age_days, 'label_prints', v.label_prints) order by v.received_at), '[]')
          from v_nexus_pallets v where v.location_id = l.id and v.org_id = any(a.org_ids) and (a.can ->> 'brands')::boolean)) order by l.code), '[]')
      from locations l where l.active and l.kind in ('pallet', 'floor', 'dock')),
    'unplaced', (select coalesce(jsonb_agg(jsonb_build_object('psku', v.psku, 'brand', v.org_name, 'item', v.item_name, 'status', v.status, 'held', v.held, 'label_prints', v.label_prints, 'received_at', v.received_at) order by v.received_at desc), '[]')
      from v_nexus_pallets v where v.location_id is null and v.org_id = any(a.org_ids) and (a.can ->> 'brands')::boolean));
end $$;
-- a scan in the window: pallet label + position label. Puts a waiting pallet away, or moves a stored one. Own brands only.
create function public.nexus_api_scan(p_key text, p_psku text, p_location text) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare a record; p wms_pallets; l locations; v_from text; v_loc text := upper(regexp_replace(btrim(coalesce(p_location, '')), '^LOC-', '', 'i')); v_new boolean;
begin
  select * into a from _nexus_api_auth(p_key);
  if not (a.can ->> 'scan')::boolean then raise exception 'This key cannot scan pallets in.'; end if;
  select * into p from wms_pallets where upper(psku) = upper(btrim(coalesce(p_psku, ''))) and org_id = any(a.org_ids) for update;
  if p.id is null or p.status = 'void' then raise exception 'Pallet % is not on file for this connection.', coalesce(nullif(btrim(p_psku), ''), '(blank)'); end if;
  if p.held then raise exception '% is on HOLD (%): an admin must release it first.', p.psku, coalesce(p.hold_reason, 'no reason given'); end if;
  select * into l from locations where upper(code) = v_loc and active;
  if l.id is null or l.kind not in ('pallet', 'floor') then raise exception 'Position % is not a pallet position.', coalesce(nullif(v_loc, ''), '(blank)'); end if;
  if l.id is not distinct from p.location_id and p.status = 'stored' then raise exception '% is already at %.', p.psku, l.code; end if;
  if l.kind = 'pallet' and exists (select 1 from wms_pallets x where x.location_id = l.id and x.status in ('counted', 'stored') and x.id <> p.id) then raise exception 'Position % already holds a pallet.', l.code; end if;
  v_new := p.status <> 'stored'; select code into v_from from locations where id = p.location_id;
  update wms_pallets set location_id = l.id, status = 'stored', stored_at = case when v_new then now() else stored_at end, stored_by_name = case when v_new then a.name else stored_by_name end,
    counted_at = coalesce(counted_at, now()), counted_by_name = coalesce(counted_by_name, a.name) where id = p.id;
  insert into nexus_moves (pallet_id, psku, org_id, action, from_code, to_code, actor_name, source) values (p.id, p.psku, p.org_id, case when v_new then 'putaway' else 'move' end, v_from, l.code, a.name, a.name || ' (' || a.access || ' window)');
  return jsonb_build_object('psku', p.psku, 'from', v_from, 'to', l.code, 'put_away', v_new);
end $$;
create function public.nexus_api_shipments(p_key text, p_from date, p_to date) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare a record;
begin
  select * into a from _nexus_api_auth(p_key);
  if a.access <> 'admin' or not (a.can ->> 'calendar')::boolean then raise exception 'This key cannot see the shipment calendar.'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'org_id', i.org_id, 'brand', g.name, 'reference', i.reference, 'origin', i.origin, 'expected_at', i.expected_at, 'pallets', i.pallets, 'cartons', i.cartons,
      'status', i.status, 'approved', i.approved_at is not null, 'notes', i.notes, 'received_at', i.received_at, 'received_pallets', (select count(*) from wms_pallets p where p.inbound_id = i.id and p.status <> 'void')) order by i.expected_at, g.name), '[]')
    from inbound_shipments i join orgs g on g.id = i.org_id where i.org_id = any(a.org_ids) and i.status <> 'cancelled' and i.expected_at between p_from and p_to);
end $$;
-- book or change an incoming shipment from the admin window. A new booking waits for Nexus to confirm it.
create function public.nexus_api_shipment_save(p_key text, p_body jsonb) returns uuid language plpgsql security definer set search_path to 'public' as $$
declare a record; i inbound_shipments; v_id uuid := nullif(p_body ->> 'id', '')::uuid; v_org uuid := nullif(p_body ->> 'org_id', '')::uuid; v_day date := nullif(p_body ->> 'expected_at', '')::date; v_pal int := coalesce((p_body ->> 'pallets')::int, 0);
begin
  select * into a from _nexus_api_auth(p_key);
  if a.access <> 'admin' or not (a.can ->> 'calendar')::boolean then raise exception 'This key cannot change the shipment calendar.'; end if;
  if v_day is null or v_pal < 1 or v_pal > 200 then raise exception 'An expected date and 1 to 200 pallets are needed.'; end if;
  if v_id is null then
    if v_org is null or not v_org = any(a.org_ids) then raise exception 'Pick one of this connection''s brands.'; end if;
    if coalesce(btrim(p_body ->> 'reference'), '') = '' then raise exception 'Give the shipment a reference.'; end if;
    insert into inbound_shipments (org_id, reference, status, origin, expected_at, pallets, cartons, notes)
    values (v_org, btrim(p_body ->> 'reference'), 'expected', nullif(btrim(p_body ->> 'origin'), ''), v_day, v_pal, coalesce((p_body ->> 'cartons')::int, 0), nullif(btrim(coalesce(p_body ->> 'notes', '') || ' [booked from ' || a.name || ']'), '')) returning id into v_id;
    return v_id;
  end if;
  select * into i from inbound_shipments where id = v_id and org_id = any(a.org_ids) for update;
  if i.id is null or i.status = 'cancelled' then raise exception 'Shipment not on file for this connection.'; end if;
  if (p_body ->> 'cancel')::boolean then
    if exists (select 1 from wms_pallets where inbound_id = i.id and status <> 'void') then raise exception 'Pallets were already received against this shipment.'; end if;
    update inbound_shipments set status = 'cancelled' where id = i.id; return i.id;
  end if;
  update inbound_shipments set expected_at = v_day, pallets = v_pal, cartons = coalesce((p_body ->> 'cartons')::int, cartons), origin = coalesce(nullif(btrim(p_body ->> 'origin'), ''), origin), notes = case when p_body ? 'notes' then nullif(btrim(p_body ->> 'notes'), '') else notes end where id = i.id;
  return i.id;
end $$;
create function public.nexus_api_labels(p_key text, p_q text default null) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare a record;
begin
  select * into a from _nexus_api_auth(p_key);
  if a.access <> 'admin' or not (a.can ->> 'labels')::boolean then raise exception 'This key cannot see labels.'; end if;
  return (select coalesce(jsonb_agg(x), '[]') from (select jsonb_build_object('id', n.id, 'kind', n.kind, 'code', n.code, 'brand', g.name, 'pallet', p.psku, 'position', l.code, 'item', n.item_name, 'item_no', n.item_no,
      'source', n.source, 'made_by', n.made_by_name, 'made_at', n.made_at, 'prints', n.prints, 'last_printed_at', n.last_printed_at, 'content', n.content) x
    from nexus_labels n join orgs g on g.id = n.org_id left join wms_pallets p on p.id = n.pallet_id left join locations l on l.id = p.location_id
    where n.org_id = any(a.org_ids) and (coalesce(btrim(p_q), '') = '' or n.code ilike '%' || btrim(p_q) || '%' or n.item_name ilike '%' || btrim(p_q) || '%' or p.psku ilike '%' || btrim(p_q) || '%')
    order by n.made_at desc, n.id desc limit 300) s);
end $$;

-- ───────── Receiving in Nexus (Derek, 2026-11-21 20:42): pick whose shipment it is, receive against the booking the brand's WMS
-- holds, put the pallets away, then tell the WMS the shipment went through the whole receiving process. Receiving itself runs
-- on the functions the ShipBay WMS already uses (wms_receive_booking, nexus_putaway); nothing here re-implements them. ─────────
create function public.nexus_receiving_brands() returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform 1 from _nexus_staff();
  return (select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'open', x.n, 'pallets', x.pallets, 'next', x.next) order by (x.n = 0), x.next nulls last, g.name), '[]')
    from orgs g cross join lateral (select count(*) n, coalesce(sum(i.pallets), 0) pallets, min(i.expected_at) next from inbound_shipments i where i.org_id = g.id and i.status in ('expected', 'in_transit')) x
    where g.status <> 'churned');
end $$;
create function public.nexus_receiving(p_org uuid) returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform 1 from _nexus_staff();
  return (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'reference', i.reference, 'origin', i.origin, 'expected_at', i.expected_at, 'pallets', i.pallets, 'cartons', i.cartons, 'notes', i.notes,
      'status', i.status, 'approved', i.approved_at is not null, 'received_at', i.received_at,
      'closed', exists (select 1 from wms_receipt_links k where k.inbound_id = i.id and k.mode = 'final'),
      'lines', (select coalesce(jsonb_agg(jsonb_build_object('sku_id', s.id, 'sku', s.sku, 'name', s.name, 'qty', n.qty_expected) order by s.sku), '[]') from inbound_lines n join skus s on s.id = n.sku_id where n.inbound_id = i.id),
      'pallet_list', (select coalesce(jsonb_agg(jsonb_build_object('psku', p.psku, 'status', p.status, 'held', p.held, 'hold_reason', p.hold_reason, 'item', p.item_name, 'cartons', p.cartons, 'units', p.units_total,
          'position', (select code from locations where id = p.location_id), 'label_prints', p.label_prints, 'received_at', p.received_at, 'received_by', p.received_by_name) order by p.psku), '[]')
        from wms_pallets p where p.inbound_id = i.id and p.status <> 'void')) order by (i.status = 'received'), i.expected_at nulls last, i.reference), '[]')
    from inbound_shipments i where i.org_id = p_org and (i.status in ('expected', 'in_transit') or (i.status in ('received', 'discrepancy') and i.received_at > now() - interval '3 days')));
end $$;
-- pallets exactly as the database holds them, each with its carton rows: what a label is drawn from
create function public.nexus_label_pallets(p_pskus text[]) returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
  perform 1 from _nexus_staff();
  if coalesce(cardinality(p_pskus), 0) = 0 or cardinality(p_pskus) > 60 then raise exception 'Between 1 and 60 pallets at a time.'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('brand', g.name, '_cartons', (select coalesce(jsonb_agg(to_jsonb(c) order by c.seq), '[]') from wms_cartons c where c.pallet_id = p.id)) order by p.psku), '[]')
    from wms_pallets p join orgs g on g.id = p.org_id where p.psku = any(p_pskus) and p.status <> 'void');
end $$;
-- the whole receiving process is done: the last receipt is recorded and every pallet stands in a position. Marks the booking
-- received (or discrepancy when the counts differ from what was booked), which is what the brand's WMS and portal read.
create function public.nexus_receiving_finish(p_inbound uuid) returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare c record; i inbound_shipments; v_pal int; v_car int; v_status text;
begin
  select * into c from _nexus_staff();
  select * into i from inbound_shipments where id = p_inbound for update;
  if i.id is null then raise exception 'Shipment not on file.'; end if;
  if i.status not in ('expected', 'in_transit') then raise exception 'That shipment is already %.', i.status; end if;
  if not exists (select 1 from wms_receipt_links where inbound_id = i.id and mode = 'final') then raise exception 'Receive the last pallet as "last of this shipment" first.'; end if;
  if exists (select 1 from wms_pallets where inbound_id = i.id and status <> 'void' and held) then raise exception 'A pallet of this shipment is on HOLD. Release or void it first.'; end if;
  if exists (select 1 from wms_pallets where inbound_id = i.id and status not in ('stored', 'void')) then raise exception 'Every pallet of this shipment has to be put away first.'; end if;
  select count(*), coalesce(sum(cartons), 0) into v_pal, v_car from wms_pallets where inbound_id = i.id and status <> 'void';
  if v_pal = 0 then raise exception 'Nothing was received against this shipment.'; end if;
  v_status := case when (i.pallets > 0 and v_pal <> i.pallets) or (i.cartons > 0 and v_car <> i.cartons) then 'discrepancy' else 'received' end;
  update inbound_shipments set status = v_status, received_at = now() where id = i.id;
  insert into nexus_moves (org_id, action, to_code, changes, reason, actor, actor_name) values (i.org_id, 'received', i.reference,
    jsonb_build_object('pallets', jsonb_build_object('from', i.pallets, 'to', v_pal), 'cartons', jsonb_build_object('from', i.cartons, 'to', v_car)), 'Receiving completed in Nexus', c.uid, c.who);
  return jsonb_build_object('status', v_status, 'pallets', v_pal, 'pallets_booked', i.pallets, 'cartons', v_car, 'cartons_booked', i.cartons);
end $$;

do $$ declare f text; begin
  for f in select p.oid::regprocedure::text from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('nexus_label_pallets', 'nexus_receiving_brands', 'nexus_receiving', 'nexus_receiving_finish', 'nexus_labels_list', 'nexus_labels_printed', 'nexus_move_pallet', 'nexus_pallet_edit', 'nexus_pallet_void',
      'nexus_floor_log', 'nexus_pallet_detail', 'nexus_position_detail', 'nexus_position_edit', 'nexus_positions_off', 'nexus_dashboard', 'nexus_shipment_update', 'nexus_connections_list', 'nexus_connection_save', 'nexus_connection_new_key',
      'nexus_api_window', 'nexus_api_floor', 'nexus_api_scan', 'nexus_api_shipments', 'nexus_api_shipment_save', 'nexus_api_labels') loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
    if f like 'nexus_api_%' then execute format('grant execute on function %s to anon, authenticated', f); else execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;
commit;
