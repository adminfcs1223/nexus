#!/usr/bin/env bash
# Take a Nexus backup. Reads the source; never writes to it.
#   neutral/ops/backup.sh <source-db-url> <output-directory> [--with-credentials]
# Produces in the output directory:
#   nexus.dump        the nexus schema and data (custom format)
#   manifest.txt      when it was taken, table digests, code digest: what a restore is checked against
#   redacted/*.copy   only without --with-credentials: integrations and operators with their hashes replaced and switched off
# Never in a backup: the key_handoff rows (temporary plaintext credential pickup).
# Without --with-credentials (the default, for rehearsals): no key hash and no operator token hash leaves the database;
#   the restored copy has every integration and operator switched off.
# With --with-credentials (real disaster recovery only): hashes are included so existing keys keep working after recovery.
#   Treat that file like a credential store.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; . "$HERE/lib.sh"
SRC="$1"; OUT="$2"; MODE="${3:-}"; mkdir -p "$OUT"; chmod 700 "$OUT"
[ -e "$OUT/nexus.dump" ] && { echo "refusing to overwrite an existing backup in $OUT"; exit 2; }
ARGS=(--format=custom --schema=nexus --no-owner --no-privileges --exclude-table-data=nexus.key_handoff)
if [ "$MODE" != "--with-credentials" ]; then ARGS+=(--exclude-table-data=nexus.integrations --exclude-table-data=nexus.operators); mkdir -p "$OUT/redacted"; fi
DSQL="$(digest_sql "$SRC")"
# One snapshot for everything: the dump, the redacted copies and the digests all describe the same instant, even while
# other sessions keep writing. A helper session holds the snapshot open until the script ends.
FIFO="$(mktemp -u)"; CTL="$(mktemp -u)"; mkfifo "$FIFO" "$CTL"
PGOPTIONS="$PGSET" psql -AtqX -v ON_ERROR_STOP=1 "$SRC" < "$CTL" > /dev/null 2>&1 &
HOLDER=$!; exec 3> "$CTL"
release() { exec 3>&- 2>/dev/null || true; wait $HOLDER 2>/dev/null || true; rm -f "$FIFO" "$CTL"; }   # closing the pipe ends the helper session at once
trap release EXIT
printf '%s\n' "begin isolation level repeatable read read only;" "\\o $FIFO" "select pg_export_snapshot();" "\\o" >&3
SNAP="$(head -1 "$FIFO")"
[ -n "$SNAP" ] || { echo "could not take a snapshot of the source"; exit 1; }
snapq() { PGOPTIONS="$PGSET" psql -AtqX -v ON_ERROR_STOP=1 "$SRC" -c "begin isolation level repeatable read read only" -c "set transaction snapshot '$SNAP'" -c "$1" -c "commit"; }
pg_dump "${ARGS[@]}" --snapshot="$SNAP" --file="$OUT/nexus.dump" "$SRC"
if [ "$MODE" != "--with-credentials" ]; then
  snapq "copy (select id, company_id, source_system, warehouse, 'redacted-' || id, scopes, false, created_at, null::timestamptz, null::timestamptz, null::text from nexus.integrations order by id) to stdout" > "$OUT/redacted/integrations.copy"
  snapq "copy (select id, company_id, name, roles, 'redacted-' || id, false, created_at, null::timestamptz from nexus.operators order by id) to stdout" > "$OUT/redacted/operators.copy"
fi
{ echo "taken_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "mode=$([ "$MODE" = "--with-credentials" ] && echo with-credentials || echo redacted)"
  echo "server_version=$(q "$SRC" "show server_version")"; echo "code=$(code_digest "$SRC")"; echo "rules=$(q "$SRC" "$RULES_SQL")"
  if [ "$MODE" = "--with-credentials" ]; then echo "credentials=$(snapq "$CRED_SQL")"; fi
  echo "unlocked_real_floors=$(snapq "select coalesce(string_agg(code, ',' order by code), '') from nexus.warehouses where moves_enabled and not test")"
  snapq "$DSQL" | sort | sed 's/^/table=/'; } > "$OUT/manifest.txt"
for k in taken_at mode server_version code rules; do grep -Eq "^$k=.+" "$OUT/manifest.txt" || { echo "FAILED: the manifest has no $k; the backup is not usable"; rm -f "$OUT/nexus.dump"; exit 1; }; done
[ "$(grep -c '^table=' "$OUT/manifest.txt")" -ge 10 ] || { echo "FAILED: the manifest lists too few tables"; rm -f "$OUT/nexus.dump"; exit 1; }
release; trap - EXIT; chmod 600 "$OUT"/nexus.dump "$OUT"/manifest.txt
# proof that nothing secret is in the artefact when it is not supposed to be
if pg_restore --data-only --file=- "$OUT/nexus.dump" | grep -Eq 'nx[ko]_[0-9a-f]{20,}'; then echo "FAILED: a plaintext key is in the dump"; exit 1; fi
if [ "$MODE" != "--with-credentials" ]; then
  for h in $(q "$SRC" "select key_hash from nexus.integrations union all select token_hash from nexus.operators"); do
    if pg_restore --data-only --file=- "$OUT/nexus.dump" | grep -q "$h" || grep -rq "$h" "$OUT/redacted" "$OUT/manifest.txt"; then echo "FAILED: a credential hash is in the backup"; exit 1; fi
  done
fi
echo "backup written to $OUT ($(wc -c < "$OUT/nexus.dump") bytes, $(grep -c '^table=' "$OUT/manifest.txt") tables, mode $(grep '^mode=' "$OUT/manifest.txt" | cut -d= -f2))"
