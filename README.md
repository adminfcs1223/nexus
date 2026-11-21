# Nexus

Warehouse-floor system: floor map (Locations), pallets, FIFO, cycle counts, and a keyed read-only API for connected WMSes.
Reads the same database as the ShipBay WMS, so there is one live pallet count.

- `src/` the site (React + Vite). Netlify: build `npm ci && npm run build`, publish `dist`, no base directory.
- `database/` the SQL already applied to the ShipBay database (for reference; do not re-run).
- `test/e2e/` browser test; it runs from the ShipBay repo's local test database.

Embedded in a WMS with `?embed=1`: the WMS passes the signed-in user's access token; Nexus keeps no session there.
