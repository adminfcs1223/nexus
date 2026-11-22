# Nexus, neutral foundation (started 2026-11-22)

The rebuild of Nexus as shared warehouse infrastructure that belongs to neither company's system. Nothing here is deployed
and nothing here touches the live Nexus, ShipBay or Souled.

- `001_core.sql` — schema `nexus`: warehouses (a live floor and its test copy), companies, integration keys with scopes,
  location registry, pallets (identity only), occupancy, moves, numbered change feed, audit log; the engine `nexus.place`
  (assign / move / release) and the calls a system makes.
- `002_floor_map.sql` — the final approved map (owner's sketch, 2026-11-22, map version 3): inbound P-01..P-15 and
  P-16..P-30, outbound P-31..P-48 and P-49..P-66, staging STG-01 and STG-02; every position has its square on one shared
  grid. The live floor loads with zero occupancy, marked not initialized, assign / move / release off.
- `003_calendar.sql` — shared dock calendar; each company's system owns its own events.
- `service/` — the HTTP layer (`handler.mjs` is one Request-in, Response-out function; `server.mjs` runs it on Node).
- `API.md` — the versioned contract.
- `preview/render.mjs` — draws the prelaunch map from the service's own answers.
- `test/` — `node --test neutral/test/*.test.mjs` against a throwaway Postgres on 127.0.0.1:54318 (18 tests).

Not built yet: hosting, people's sign-in and roles, admin screens, baseline entry and verification, webhooks.
Nexus stores no product, quantity, cost or customer field; a test fails if such a column is ever added.
