# Nexus, neutral foundation (started 2026-11-22)

The rebuild of Nexus as shared warehouse infrastructure that belongs to neither company's system. Nothing here is deployed
and nothing here touches the live Nexus, ShipBay or Souled.

- `001_core.sql` — schema `nexus`: companies, integration keys with scopes, location registry, pallets (identity only),
  occupancy, moves, numbered change feed, audit log; the engine `nexus.place` (assign / move / release) and the calls a
  system makes (`api_place`, `api_occupancy`, `api_changes`, `api_moves`).
- `002_v1_map.sql` — the approved v1 floor map as the registry: P-01..P-72, STG-01/02, RCV-DOCK. P-65..P-72 and STG-02 are
  drawn on the map but were never set up as locations; they load as `unavailable` until confirmed.
- `test/engine.test.mjs` — `node --test neutral/test/engine.test.mjs` against a throwaway Postgres on 127.0.0.1:54318.

Not built yet: the HTTP layer, people's sign-in and roles, the calendar, webhooks, the new UI.
Nexus stores no product, quantity, cost or customer field; a test fails if such a column is ever added.
