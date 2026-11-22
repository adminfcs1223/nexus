#!/bin/bash
# Fresh synthetic database -> gateway -> harness build -> browser run -> stop. Shots land in /tmp/nexus-local/shots.
set -u; H="$(cd "$(dirname "$0")" && pwd)"; mkdir -p /tmp/nexus-local
"$H/load.sh" | tail -1; node "$H/gateway.mjs" > /tmp/nexus-local/gateway.log 2>&1 & G=$!
for i in $(seq 1 20); do grep -q READY /tmp/nexus-local/gateway.log && break; sleep 0.5; done
cd "$H/../.." && VITE_SUPABASE_URL=http://127.0.0.1:54341 VITE_SUPABASE_KEY=admin npx vite build --config test/local/vite.config.js > /tmp/nexus-local/build.log 2>&1 || { tail -8 /tmp/nexus-local/build.log; kill $G; exit 1; }
node "$H/run.cjs"; code=$?; kill $G; exit $code
