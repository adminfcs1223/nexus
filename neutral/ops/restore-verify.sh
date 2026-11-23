#!/usr/bin/env bash
# Restore a Nexus backup into a BRAND-NEW database and verify it. It never restores into an existing database.
#   neutral/ops/restore-verify.sh <backup-directory> <scratch-server-url> [database-name]
# The scratch server URL has no database name (for example postgres://user@host:5432). The script creates the database
# itself and stops if a database of that name already exists.
# Order of work:
#   1. restore   structure, then data, then (redacted backups) the switched-off integrations and operators, then constraints
#   2. compare   every table's digest and the code digest against the backup's manifest
#   3. LOCK      every real floor: movements off, every unlock go voided, feed numbers moved far ahead, a 'nexus_restored'
#                feed entry per floor. A restored database is locked whatever the backup said.
#   4. check     locks, no pickup rows, credentials as the mode promises, baseline fingerprints, occupancy rules,
#                counters ahead of the data, and that replaying recorded movement requests moves nothing
# Exit 0 only if everything passes. KEEP=1 keeps the scratch database for inspection.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; . "$HERE/lib.sh"
DIR="$1"; SERVER="${2%/}"; NAME="${3:-nexus_restore_$(date -u +%Y%m%d_%H%M%S)_$$}"; DB="$SERVER/$NAME"; M="$DIR/manifest.txt"; FAIL=0
ok() { echo "   ok    $1"; }; bad() { echo "   FAIL  $1"; FAIL=1; }
is() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', found '$2')"; fi; }
[ -f "$DIR/nexus.dump" ] && [ -f "$M" ] || { echo "no backup in $DIR"; exit 2; }
MODE="$(grep '^mode=' "$M" | cut -d= -f2)"; T0=$(date +%s)
[ "$(q "$SERVER/postgres" "select count(*) from pg_database where datname = '$NAME'")" = 0 ] || { echo "database $NAME already exists: refusing to restore into an existing database"; exit 2; }
echo "1. restore into new database $NAME (backup of $(grep '^taken_at=' "$M" | cut -d= -f2), mode $MODE)"
q "$SERVER/postgres" "create database \"$NAME\"" >/dev/null
R() { pg_restore --no-owner --no-privileges --exit-on-error --section="$1" --dbname="$DB" "$DIR/nexus.dump"; }
R pre-data || true
if [ -z "${SIMULATE_INTERRUPTED_RESTORE:-}" ]; then
  R data || true
  if [ "$MODE" = redacted ]; then
    psql -qX "$DB" -c "\copy nexus.integrations (id, company_id, source_system, warehouse, key_hash, scopes, active, created_at, last_ok_at, last_error_at, last_error) from '$DIR/redacted/integrations.copy'" || true
    psql -qX "$DB" -c "\copy nexus.operators (id, company_id, name, roles, token_hash, active, created_at, last_used_at) from '$DIR/redacted/operators.copy'" || true
  fi
  R post-data || true
else echo "   (restore deliberately interrupted after the structure, for the rehearsal)"; fi
T1=$(date +%s)

echo "2. compare with the backup's manifest"
EXPECT="$(grep '^table=' "$M" | sed 's/^table=//' | sort)"; GOT="$(digest "$DB" 2>/dev/null || true)"
if [ "$EXPECT" = "$GOT" ]; then ok "all $(echo "$EXPECT" | wc -l) tables match row for row"; else bad "tables differ: $(diff <(echo "$EXPECT") <(echo "$GOT") | grep '^[<>]' | cut -d'|' -f1 | sed 's/^[<>] //' | sort -u | tr '\n' ' ')"; fi
is "functions are the ones that were backed up" "$(code_digest "$DB" 2>/dev/null || echo none)" "$(grep '^code=' "$M" | cut -d= -f2)"
is "the floor-lock, one-place-per-pallet and one-row-per-key rules came back with the data" "$(q "$DB" "$RULES_SQL" 2>/dev/null || echo none)" "$(grep '^rules=' "$M" | cut -d= -f2)"
if [ $FAIL = 1 ]; then
  echo "RESTORE NOT VERIFIED. Do not use this database. Drop it and restore again from the backup."
  [ "${KEEP:-0}" = 1 ] || q "$SERVER/postgres" "drop database \"$NAME\"" >/dev/null; exit 1
fi

echo "3. lock every real floor in the restored copy"
WAS="$(grep '^unlocked_real_floors=' "$M" | cut -d= -f2)"; [ -n "$WAS" ] && echo "   the backup was taken while these real floors were open: $WAS"
q "$DB" "
  insert into nexus.audit_log (actor, action, warehouse, target, after) select 'restore-verify', 'restored_and_locked', code, null, jsonb_build_object('backup_taken_at', '$(grep '^taken_at=' "$M" | cut -d= -f2)', 'was_open_in_backup', moves_enabled) from nexus.warehouses where not test;
  update nexus.warehouses set moves_enabled = false, last_stopped_at = now() where not test;
  update nexus.unlock_approvals set voided_at = now() where voided_at is null;
  select setval('nexus.change_log_seq_seq', (select coalesce(max(seq), 0) from nexus.change_log) + 1000000);
  insert into nexus.change_log (warehouse, kind) select code, 'nexus_restored' from nexus.warehouses order by code;" >/dev/null

echo "4. checks on the restored copy"
is "no real floor has movements on" "$(q "$DB" "select count(*) from nexus.warehouses where not test and moves_enabled")" 0
is "no unlock go survives the restore, so unlocking needs fresh approval from every company" "$(q "$DB" "select count(*) from nexus.unlock_approvals where voided_at is null")" 0
is "no floor gained or lost its initialized state" "$(q "$DB" "select count(*) from nexus.warehouses w where not w.test and (w.occupancy_state = 'not_initialized') <> not exists (select 1 from nexus.baselines b where b.warehouse = w.code and b.status = 'applied')")" 0
if [ "$(q "$DB" "select to_regclass('nexus.key_handoff') is not null")" = t ]; then is "no credential pickup rows" "$(q "$DB" "select count(*) from nexus.key_handoff")" 0; else ok "no credential pickup table in this database"; fi
if [ "$MODE" = redacted ]; then
  is "no usable integration key or operator token in the copy" "$(q "$DB" "select (select count(*) from nexus.integrations where active or key_hash ~ '^[0-9a-f]{64}\$') + (select count(*) from nexus.operators where active or token_hash ~ '^[0-9a-f]{64}\$')")" 0
else
  is "credentials are the ones that were backed up" "$(q "$DB" "$CRED_SQL")" "$(grep '^credentials=' "$M" | cut -d= -f2)"
fi
is "every stored baseline still matches its fingerprint" "$(q "$DB" "select count(*) from nexus.baselines where nexus._baseline_fingerprint(map_version, map_checksum, content) <> fingerprint")" 0
is "no position holds more than its capacity" "$(q "$DB" "select count(*) from (select l.id from nexus.locations l join nexus.occupancy o on o.location_id = l.id where l.capacity is not null group by l.id, l.capacity having count(*) > l.capacity) x")" 0
is "every pallet stands on its own floor, once" "$(q "$DB" "select (select count(*) from nexus.occupancy o join nexus.pallets p on p.id = o.pallet_id join nexus.locations l on l.id = o.location_id where l.warehouse <> p.warehouse) + (select count(*) from (select pallet_id from nexus.occupancy group by 1 having count(*) > 1) d)")" 0
is "one history row per idempotency key" "$(q "$DB" "select count(*) from (select requester, idempotency_key from nexus.moves group by 1, 2 having count(*) > 1) d")" 0
is "counters are ahead of the data, so new records cannot collide with restored ones" "$(q "$DB" "select (select count(*) from nexus.moves where id > (select last_value from nexus.moves_id_seq)) + (select count(*) from nexus.change_log where seq > (select last_value from nexus.change_log_seq_seq)) + (select count(*) from nexus.audit_log where id > (select last_value from nexus.audit_log_id_seq))")" 0
is "the feed jumped ahead and announces the restore on every floor" "$(q "$DB" "select ((min(seq) > coalesce((select max(seq) from nexus.change_log where kind <> 'nexus_restored'), 0) + 999999) and count(*) = (select count(*) from nexus.warehouses))::text from nexus.change_log where kind = 'nexus_restored'")" true
# Replay every recorded movement request exactly as it was first sent. On an open (test) floor each must answer
# 'replayed' and change nothing; on a locked floor each must be refused. Inside a transaction that is rolled back.
REPLAY="$(PGOPTIONS="$PGSET" psql -AtqX -v ON_ERROR_STOP=1 "$DB" <<'SQL'
begin;
create temp table _before on commit drop as select (select count(*) from nexus.occupancy) o, (select count(*) from nexus.moves) m, (select md5(coalesce(string_agg(pallet_id::text || location_id::text, ',' order by pallet_id), '')) from nexus.occupancy) h;
create temp table _r on commit drop as
  select w.moves_enabled open, nexus.place(m.requester, m.warehouse, m.company_id, 'restore-verify', m.kind, m.external_id, m.request ->> 'to', m.request ->> 'from', m.idempotency_key) r
  from nexus.moves m join nexus.warehouses w on w.code = m.warehouse where m.request is not null order by m.id;
select (select count(*) from _r) || ' sent again, ' || (select count(*) from _r where open and r ->> 'replayed' is distinct from 'true') || ' acted again, ' || (select count(*) from _r where not open and r ->> 'error' is distinct from 'occupancy_not_initialized') || ' slipped past a lock, changed='
  || ((select o from _before) <> (select count(*) from nexus.occupancy) or (select m from _before) <> (select count(*) from nexus.moves) or (select h from _before) <> (select md5(coalesce(string_agg(pallet_id::text || location_id::text, ',' order by pallet_id), '')) from nexus.occupancy));
rollback;
SQL
)"
case "$REPLAY" in *" sent again, 0 acted again, 0 slipped past a lock, changed=false") ok "recorded movement requests sent again move nothing ($REPLAY)";; *) bad "replay check: $REPLAY";; esac
T2=$(date +%s)
echo "   restore took $((T1 - T0))s, verification $((T2 - T1))s"
if [ "${KEEP:-0}" = 1 ]; then echo "   scratch database kept: $NAME"; else q "$SERVER/postgres" "drop database \"$NAME\"" >/dev/null; fi
if [ $FAIL = 0 ]; then echo "RESTORE VERIFIED AND LOCKED"; else echo "RESTORE NOT VERIFIED. Do not use this database."; fi; exit $FAIL
