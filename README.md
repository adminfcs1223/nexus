# Nexus

Warehouse-floor system: floor map (Locations), pallets, FIFO, cycle counts, and a keyed read-only API for connected WMSes.
Reads the same database as the ShipBay WMS, so there is one live pallet count.

- `src/` the site (React + Vite). Netlify: build `npm ci && npm run build`, publish `dist`, no base directory.
- `database/` the SQL already applied to the ShipBay database (for reference; do not re-run).
- `test/e2e/` browser test; it runs from the ShipBay repo's local test database.

Embedded in a WMS with `?embed=1`: the WMS passes the signed-in user's access token; Nexus keeps no session there.

## v2 (live 2026-11-21)
Dashboard (mini floor map, capacity ring, shipment calendar) with Calendar and Labeling under it; Receiving; Floor; Pallets with a
page per pallet; FIFO marked under construction; Cycle counts; Connections (two keys per site, permissions).
- **Receiving** runs here: who the shipment is for -> the booked shipment (its contents come from the brand's WMS) -> receive
  (one product or a mixed pallet, FBA, NCC, off-list product, several alike, HOLD, carton labels before Receive) -> put away
  (pallet label + position code) -> Complete, which marks the booking received / discrepancy for the brand's WMS.
  It calls the WMS's own `wms_receive_booking` and `wms_hold_pskus`; nothing is re-implemented.
- **Labels**: Nexus is the label source. `src/labels/` holds the designs carried over from the ShipBay WMS; every label is in
  `nexus_labels`. Floor prints 4x6 position labels and the letter-size pallet-jack scan sheet.
- **Inside a WMS**: `/?embed=1` is the live floor map, `/?embed=receiving` is the Receiving screen (the WMS passes the signed-in
  user's token). **Inside any other site**: `/?window=floor#k=<key>` or `/?window=admin#k=<key>`; that site's address must be in
  `frame-ancestors` in `netlify.toml`.
- `database/20261121_nexus_v2.sql` is applied to the ShipBay database. Rollback beside it.
- `test/local/` runs everything with no production access: `./run.sh` (throwaway Postgres on 127.0.0.1:54318, synthetic data,
  the real nexus_* functions and the real WMS receiving functions, the real screens in Chromium) and `node --test db.test.mjs`.
  `test/e2e/` is the older run and still describes the v1 screens.

## Sites and the two-way link (live 2026-11-22)
A site is a WMS that uses the warehouse (ShipBay, Souled). Receiving, Calendar, Dashboard and Pallets show the site first and
the brand as "c/o". The **Sites** tab holds each site's brands and how it connects, with an **Add a site** wizard that ends on
a connection check. Printed labels stay brand-first.
- `shared` site (ShipBay): its WMS is on this database, so it is always live.
- `api` site (Souled, its own build): with its admin key it pushes its product list and bookings in
  (`nexus_api_products`, `nexus_api_shipment_save`; the same brand + reference again changes the same booking) and reads a
  numbered feed of floor events out (`nexus_api_events(key, after)`): pallet received / put away / moved / on hold / voided,
  shipment received / discrepancy / cancelled. Sites shows when it was last heard from.
- `database/20261122_nexus_sites.sql` and `database/20261122_nexus_two_way.sql` are applied. Rollbacks beside them.
