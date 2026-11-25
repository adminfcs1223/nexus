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
- `MVP-CONTRACT.md` — the short contract for both warehouse applications, with recorded request and answer examples
  (built by `contract/build.py` from `test/mvp-acceptance.test.mjs`).
- `preview/render.mjs` — draws the prelaunch map from the service's own answers.
- `004_baseline.sql` — baseline controls for a real floor: operators and roles, submit / approve / initialize / revert, unlock
  approvals and unlock, stop, capacity verification, discrepancies, floor status and audit, snapshot digest.
- `006_admin_controls.sql`, `ADMIN.md` — the administrator controls: floor-assigned operators, table-level
  lock guards, service roles and the permission audit. Local only.
- `010_forward_only.sql` — forward-only launch: a real floor opened blank, every placement carrying a per-location empty
  confirmation. On the hosted project since 2026-11-24; HILLSBOROUGH is open in this mode (rollback: `ops/rollback-010.sql`).
- `011_retire_floor.sql` — archive-then-retire for a test floor (nothing deleted). HILLSBOROUGH-TEST was retired on the hosted
  project on 2026-11-24; real HILLSBOROUGH is the only active floor.
- `008_admin_hardening.sql`, `009_owner_role.sql` — administrator access hardened: short sessions with authenticator codes, one
  recorded entry point, separated authority, append-only audit, break-glass codes, an owner role with no login. Local only.
- `007_destinations_only.sql` — pallets are stored only at drawn destinations; the dock stays visible and can never be assigned
  or moved into. On Nexus staging since 2026-11-23 12:25 ET (rollback: `ops/rollback-007.sql`).
- `client/occupancy-check.mjs` — reference check of an occupancy answer against the map.
- `ops/backup-rehearsal.sh` — backup, restore into a scratch database, and table-by-table comparison.
- `migration/` — old site numbering to map version 4 (a mapping for people; nothing is imported).
- `baseline/` — dry-run tooling for the real floor's first occupancy baseline: `make-sheet.mjs` writes the blank count sheet,
  `validate.mjs` checks filled sheets and prints a report. It opens no database or network connection.
- `test/` — `node --test neutral/test/*.test.mjs` against a throwaway Postgres on 127.0.0.1:54318 (58 tests; the 9 validator tests need no database).

Not built yet: hosting, people's sign-in and roles, admin screens, baseline entry and verification, webhooks.
Nexus stores no product, quantity, cost or customer field; a test fails if such a column is ever added.
