# Nexus — shared RECEIVING / OUTBOUND zone (Stage 2, task 1)

Live on `HILLSBOROUGH` since 2026-11-27. API version `1.2.0`. For the Souled and ShipBay developers. No keys in this file.
Base URL, keys and every Stage 1 call are unchanged (`PRODUCTION-CONNECTION.md`).

## The zone
| | |
|---|---|
| Location code | `RCV-OUT` |
| `kind` | `zone` (new value; existing kinds are `pallet`, `staging`, `dock`) |
| `zone` / `block` | `receiving_outbound` |
| Capacity | none (`capacity: null`, `free: null`). The drawn size is a floor reference only |
| Shared | yes: any number of pallets of both companies at the same time |
| Map version / checksum | `5` / `91d76cdefd051ca8d4f4a45c425b98cd404e05b077816eb9b4e14252f872b191` (was `4` / `be3cc8f3…`) |

Nothing else on the map changed: `P-01`–`P-66`, `STG-01`, `STG-02` and `RCV-DOCK` have the same codes, coordinates, capacity and rules.
`RCV-DOCK` is still not a storage location.

## Where to draw it
`GET /v1/map` → `positions` now has 70 entries. The zone's entry has `x: null, y: null`; its rectangle is in `layout.blocks`:

```json
{ "key": "receiving_outbound", "label": "Receiving / Outbound", "side": "left", "x": [1, 2], "y": [-2, 0], "location": "RCV-OUT", "shared": true, "footprint": "visual only, not a capacity" }
```

`layout.grid.top_rows` is `3`: three extra rows above row 1 (y = -2, -1, 0). Columns 1–2, so it sits under the Exit, above the
left-hand rows, left of the dock. Existing positions keep their `x` / `y`; shift your drawing down by `top_rows`, do not renumber.
Draw one outlined rectangle labelled "Receiving / Outbound", not six tiles, and do not count it in open / occupied position totals.

## Moving pallets in and out
Same three calls, same headers (`Authorization: Bearer <movement key>`, `Idempotency-Key`), same pallet ids.

**Into the zone** (`assign` for a pallet not yet in Nexus, `move` for one already on the floor): send `zone_status`.

```http
POST /v1/pallets/assign
{ "pallet": "<your pallet id>", "to": "RCV-OUT", "zone_status": "inbound", "confirmed_by": "<who handled it>" }

POST /v1/pallets/move
{ "pallet": "<your pallet id>", "from": "P-41", "to": "RCV-OUT", "zone_status": "outbound", "confirmed_by": "<who handled it>" }
```

- `zone_status` is required: `"inbound"` or `"outbound"` (a JSON string). Missing or anything else → HTTP 400 `zone_status_required`, nothing recorded, the same Idempotency-Key can be sent again.
- `confirmed_empty` is **not** used for the zone (it is never empty by design). `confirmed_by` is optional and recorded when sent.
- Success: `{ "ok": true, "pallet": "…", "location": "RCV-OUT", "from": null | "<code>", "seq": n, "free": null, "zone_status": "inbound" }`.
- The zone is never `location_full`.

**Change a pallet's status while it stays in the zone** (for example received, then going straight back out):

```http
POST /v1/pallets/move
{ "pallet": "<your pallet id>", "from": "RCV-OUT", "to": "RCV-OUT", "zone_status": "outbound" }
```
→ `{ "ok": true, "location": "RCV-OUT", "from": "RCV-OUT", "zone_status": "outbound", "status_changed": true, … }`. Same status again → 409 `already_there`.

**Out of the zone to a numbered or staging position**: exactly the Stage 1 move. `confirmed_empty: true` and `confirmed_by` are required as for any placement; do not send `zone_status` (it is ignored outside the zone).

```http
POST /v1/pallets/move
{ "pallet": "<your pallet id>", "from": "RCV-OUT", "to": "P-12", "confirmed_empty": true, "confirmed_by": "<who checked P-12>" }
```

**Out of the building**: `POST /v1/pallets/release { "pallet": "<your pallet id>", "from": "RCV-OUT" }`. Unchanged.

Unchanged rules that also apply here: `from` is checked (`pallet_elsewhere` if wrong); a company can only move its own pallets
(`pallet_not_found` otherwise); a key replays its recorded answer; the same key with a different `zone_status` is `idempotency_key_reused`;
the zone can be closed by Nexus (`location_unavailable` / `location_blocked` on entry; leaving and release still work).

## Reading the zone
`GET /v1/occupancy` → the `RCV-OUT` entry. Every other location answers exactly as before.

```json
{ "code": "RCV-OUT", "kind": "zone", "zone": "receiving_outbound", "status": "open", "capacity": null, "used": 5, "free": null, "shared": true,
  "occupants": [ { "company": "SHIPBAY", "pallets": 3, "inbound": 2, "outbound": 1 }, { "company": "SOULED", "pallets": 2, "inbound": 0, "outbound": 2 } ],
  "your_pallets": ["<your id>", "<your id>"],
  "your_pallets_status": [ { "pallet": "<your id>", "zone_status": "outbound", "since": "…" } ] }
```

- You see the other company's counts (total, inbound, outbound). You never see its pallet ids.
- `GET /v1/moves` entries carry `zone_status` when the movement set one. `GET /v1/changes` is unchanged (`pallet_assigned`, `pallet_moved`, `pallet_released` with `location: "RCV-OUT"`); one `map_changed` entry marks the new map.

## What each WMS implements
1. Draw the rectangle from `layout.blocks` / `top_rows`; refresh any stored map version or checksum to the values above.
2. Treat `kind: "zone"` as a multi-pallet shared location: no "occupied by the other company, blocked" logic, no capacity check, no empty-position prompt.
3. On receiving and on staging for outbound, send the pallet to `RCV-OUT` with the right `zone_status`. On put-away, move it out with the normal position confirmation. On departure, release it from `RCV-OUT`.
4. Show your own pallets in the zone with their status from `your_pallets_status`; show the other company as counts only.
5. Keep no local copy of zone occupancy as the authority; read it from Nexus.
