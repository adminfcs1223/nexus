#!/usr/bin/env bash
# Backup and restoration rehearsal for a Nexus database. Repeatable; it never writes to the source.
#   neutral/ops/backup-rehearsal.sh <source-db-url> <scratch-server-url>
# 1. takes the source's digest (every nexus table: row count and content hash)
# 2. dumps the nexus schema to a file
# 3. restores the file into a brand-new scratch database on the scratch server
# 4. takes the restored copy's digest and compares the two, table by table
# 5. proves the restored copy works: the movement lock, the map checksum and a read answer the same as the source
# The scratch database is dropped at the end unless KEEP=1. Exit 0 only if every comparison matches.
set -euo pipefail
SRC="$1"; SCRATCH_SERVER="$2"; NAME="nexus_restore_$(date +%Y%m%d_%H%M%S)"; FILE="${TMPDIR:-/tmp}/$NAME.dump"
q() { psql -AtX -v ON_ERROR_STOP=1 "$1" -c "$2"; }
echo "1. digest of the source"; BEFORE="$(q "$SRC" "select nexus.snapshot_digest()")"
echo "2. backup -> $FILE"; pg_dump --format=custom --schema=nexus --no-owner --no-privileges --file="$FILE" "$SRC"; ls -l "$FILE" | awk '{print "   " $5 " bytes"}'
echo "3. restore into scratch database $NAME"; q "$SCRATCH_SERVER/postgres" "create database $NAME" >/dev/null
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$SCRATCH_SERVER/$NAME" "$FILE"
echo "4. digest of the restored copy"; AFTER="$(q "$SCRATCH_SERVER/$NAME" "select nexus.snapshot_digest()")"
RESULT=0
DIFF="$(q "$SCRATCH_SERVER/$NAME" "select coalesce(string_agg(a.key, ', '), '') from jsonb_each('$BEFORE'::jsonb) a full join jsonb_each('$AFTER'::jsonb) b on a.key = b.key where a.value is distinct from b.value")"
if [ -n "$DIFF" ]; then echo "   MISMATCH in: $DIFF"; RESULT=1; else echo "   every table matches ($(q "$SCRATCH_SERVER/$NAME" "select count(*) - 1 from jsonb_object_keys('$AFTER'::jsonb)") tables)"; fi
echo "5. the restored copy behaves like the source"
CHECK="select string_agg(code || ':' || occupancy_state || ':' || moves_enabled || ':' || map_version || ':' || nexus._map_checksum(code), ' ' order by code) from nexus.warehouses"
if [ "$(q "$SRC" "$CHECK")" = "$(q "$SCRATCH_SERVER/$NAME" "$CHECK")" ]; then echo "   floors, locks and map checksums match"; else echo "   MISMATCH in floor state"; RESULT=1; fi
LOCK="select count(*) from pg_constraint where conrelid = 'nexus.warehouses'::regclass and contype = 'c'"
if [ "$(q "$SRC" "$LOCK")" = "$(q "$SCRATCH_SERVER/$NAME" "$LOCK")" ]; then echo "   the lock rules were restored with the data"; else echo "   MISMATCH in lock rules"; RESULT=1; fi
[ "${KEEP:-0}" = 1 ] || { q "$SCRATCH_SERVER/postgres" "drop database $NAME" >/dev/null; rm -f "$FILE"; }
[ $RESULT = 0 ] && echo "REHEARSAL PASSED" || echo "REHEARSAL FAILED"; exit $RESULT
