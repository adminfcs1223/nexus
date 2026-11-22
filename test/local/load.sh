#!/bin/bash
# Rebuild the throwaway local Nexus database (127.0.0.1:54318, database "nexuslocal") from the stub + the repo's SQL + synthetic seed.
set -e; H="$(cd "$(dirname "$0")" && pwd)"; P="psql -h 127.0.0.1 -p 54318 -U postgres -v ON_ERROR_STOP=1 -q"
$P -d postgres -c "drop database if exists nexuslocal" -c "create database nexuslocal"
$P -d postgres -c "drop role if exists anon" -c "drop role if exists authenticated" -c "drop role if exists service_role" 2>/dev/null || true
for f in $H/stub.sql $H/wms-live.sql $H/../../database/20261124_nexus.sql $H/../../database/20261124_nexus_map.sql $H/live.sql $H/../../database/20261121_nexus_v2.sql $H/seed.sql $H/../../database/20261122_nexus_sites.sql; do echo "== $(basename $f)"; $P -d nexuslocal -f $f >/dev/null; done; echo LOADED
