# Nexus

Warehouse-floor system: floor map (Locations), pallets, FIFO, cycle counts, and a keyed read-only API for connected WMSes.
Reads the same database as the ShipBay WMS, so there is one live pallet count.

- `src/` the site (React + Vite). Netlify: build `npm ci && npm run build`, publish `dist`, no base directory.
- `database/` the SQL already applied to the ShipBay database (for reference; do not re-run).
- `test/e2e/` browser test; it runs from the ShipBay repo's local test database.

Embedded in a WMS with `?embed=1`: the WMS passes the signed-in user's access token; Nexus keeps no session there.

## v2 (branch `nexus-v2-dashboard-floor-windows`, 2026-11-21) — built and tested locally, NOT live
Dashboard (mini floor map, capacity ring, shipment calendar) with Calendar and Labeling under it, Receiving (pick whose
shipment, receive against the WMS's booking, labels from Nexus, put away, complete: the booking is marked received), Floor (move a pallet, override
what a WMS entered, every position's details, add / change / turn off positions, floor log), fuller Pallets with admin actions,
FIFO marked under construction, Connections with two keys per site (floor window / admin window) and permissions.
- `database/20261121_nexus_v2.sql` is a candidate: it has **not** been applied to the ShipBay database. The screens on this
  branch need it. Rollback beside it.
- A key window is `/?window=floor#k=<key>` or `/?window=admin#k=<key>`. To load inside a site, that site's address must be
  added to `frame-ancestors` in `netlify.toml`.
- `test/local/` runs everything here with no production access: `./run.sh` (throwaway Postgres on 127.0.0.1:54318, synthetic
  data, the real functions, the real screens in Chromium) and `node --test db.test.mjs`. `test/e2e/` is the older run and still
  describes the v1 screens.
