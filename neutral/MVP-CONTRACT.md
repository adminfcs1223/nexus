# Nexus MVP contract for Souled and ShipBay (2026-11-24)

What Nexus does: one shared registry of physical locations on the Hillsborough floor and which company's pallet stands where.
What Nexus does not hold: products, SKUs, quantities, orders, customers, costs. Those stay in each company's own system.

Every example below is a real request and answer recorded by `neutral/test/mvp-acceptance.test.mjs` on a local copy of
exactly what staging runs. Pallet ids in the examples are made up.

## Connection
- Base URL (staging): `https://ankoqruedjujyefhrmtw.supabase.co/functions/v1/nexus`
- `Authorization: Bearer <key>` on every call except health. Server to server only. A key in the address is refused.
- A key fixes the company, the system and the floor. Nothing in a request can name another company or floor.
- Staging keys are bound to `HILLSBOROUGH-TEST` (synthetic). Scopes: `read`, `move`, `calendar`.
- Every answer is JSON with `ok`. A refusal is `{"ok": false, "error": "<code>", "message": "…"}`. Branch on `error`, not on `message`.

## Calls
| Call | Scope | Purpose |
|---|---|---|
| `GET /v1/health` | none | Service is up. |
| `GET /v1/map` | read | Locations, their squares, `map_version`, `checksum`. |
| `GET /v1/occupancy` | read | Every location: status, capacity, used, free, which companies. |
| `POST /v1/pallets/assign` `{pallet, to}` | move | Put a pallet that is not on the floor into a location (receiving put-away). |
| `POST /v1/pallets/move` `{pallet, to, from}` | move | Move a pallet. Always send `from`. |
| `POST /v1/pallets/release` `{pallet, from}` | move | The pallet leaves the floor. |
| `GET /v1/moves?pallet=&before=&limit=` | read | The caller's own request history, refusals included. |
| `GET /v1/changes?after=<seq>&limit=` | read | Numbered feed of floor changes, to stay in sync. |

## Rules both applications must follow
1. **Ask Nexus first.** A put-away or move is real only when Nexus answers 200. On any refusal, do not change your own inventory location.
2. **One `Idempotency-Key` per intended operation** (1 to 128 characters), generated once and stored with your own record of the operation.
   - Same key, identical request: the first answer again with `"replayed": true`. Nothing moves twice.
   - Same key, different pallet, action, `to` or `from`: 409 `idempotency_key_reused`.
   - A refusal is kept under its key for good. A new attempt after a refusal needs a new key.
   - 400, 401, 403, 423 and 503 are not kept: resend with the same key.
3. **Always send `from` on move and release.** Without it Nexus moves the pallet from wherever it stands, and a stale screen is not caught.
4. **On a timeout or 503, resend the same request with the same key** until you get an answer. Nothing is ever half-done.
5. **Draw and validate from `/v1/map`**, never from a fixed list. A destination is a position with a square (`x`, `y`). `RCV-DOCK` is not one. `x`, `y` are the square on the floor grid; `col`, `row` are the place within its block.
6. **Location status** is `open`, `blocked` or `unavailable`. A position is occupied when `used > 0` and full when `free` is 0. `capacity` and `free` are `null` where no limit is set (today `STG-01`, `STG-02`).
7. **Pallet ids are yours.** Nexus stores them exactly as sent, per company. The other company never sees them, and the same text used by both companies means two separate pallets.

## Answers by HTTP status
| HTTP | `error` | Meaning | What to do |
|---|---|---|---|
| 200 | none | Done (or `replayed`). | Record it. |
| 400 | `bad_request` | Missing pallet, key or body problem. | Fix the request. |
| 401 | `unauthorized` | Unknown or deactivated key. | Check the secret. |
| 403 | `forbidden` | Key lacks the scope. | Use the movement key. |
| 404 | `location_not_found` | No location with that code. | Refresh the map. |
| 404 | `pallet_not_found` | The caller's company has no such pallet (also the answer for the other company's pallet). | Assign it first. |
| 409 | `location_full` | No room. Carries `capacity`, `used`. | Pick another position. |
| 409 | `location_not_a_destination` | Exists but is not a storage position (`RCV-DOCK`). | Pick a drawn position. |
| 409 | `location_blocked`, `location_unavailable` | Taken out of use; `message` gives the reason. | Pick another position. |
| 409 | `pallet_elsewhere` | Not where the request says, or already on the floor. Carries the true `location`. | Refresh, then retry with a new key. |
| 409 | `pallet_not_placed` | Known pallet that is not on the floor. | Assign it. |
| 409 | `already_there` | Destination equals current position. | Nothing to do. |
| 409 | `idempotency_key_reused` | Key was used for a different request. | New key. |
| 423 | `occupancy_not_initialized` | The floor is locked (the real floor today). | Stop; do not retry automatically. |
| 503 | `unavailable` | Nexus could not complete it. Nothing changed. | Resend, same key. |

Treat any `error` you do not recognise as a refusal: nothing changed.

## Examples

### Reading
**The map** (caller: SOULED)
```
GET /v1/map

200
{
  "ok": true,
  "test": true,
  "layout": {"grid": {"x": "left to right", "y": "top to bottom", "cols": 5, "rows": 18, "origin": "top-left"}, "blocks": [{"x": [1, 2], "y": [1, 18], "key": "outbound", "side": "left", "label": "Outbound"}, {"x": [3, 3], "y": [1, 18], "key": "walkway", "side": "centre", "label": "Walkway"}, {"x": [4, 5], "y": [1, 15], "key": "inbound", "side": "right", "label": "Inbound"}, {"x": [4, 5], "y": [16, 16], "key": "staging", "side": "right", "label": "Staging"}]},
  "checksum": "be3cc8f3e9134cb4dfe7d3ac41773bc5d231ed56b4a42c05f5939467d67c8c4f",
  "landmarks": [{"x": [1, 2], "at": "top-left", "key": "exit", "edge": "top", "label": "Exit"}, "\u2026 4 more"],
  "not_drawn": [],
  "positions": [
    {"x": null, "y": null, "col": 1, "row": 1, "code": "RCV-DOCK", "kind": "dock", "zone": "receiving", "block": "dock", "status": "open", "capacity": null},
    {"x": 4, "y": 1, "col": 1, "row": 1, "code": "P-01", "kind": "pallet", "zone": "inbound", "block": "inbound", "status": "open", "capacity": 1},
    {"x": 1, "y": 1, "col": 1, "row": 1, "code": "P-31", "kind": "pallet", "zone": "outbound", "block": "outbound", "status": "open", "capacity": 1},
    {"x": 4, "y": 16, "col": 1, "row": 1, "code": "STG-01", "kind": "staging", "zone": "staging", "block": "staging", "status": "open", "capacity": null},
    "\u2026 65 more"
  ],
  "warehouse": "HILLSBOROUGH-TEST",
  "map_version": 4,
  "moves_enabled": true,
  "occupancy_state": "synthetic"
}
```

**Occupancy entries as SHIPBAY sees them: its own pallet, the other company's pallet, an empty position** (caller: SHIPBAY)
```
GET /v1/occupancy

200
{
  "ok": true,
  "warehouse": "HILLSBOROUGH-TEST",
  "occupancy_state": "synthetic",
  "moves_enabled": true,
  "as_of": "2026-11-24T09:18:56.158043-05:00",
  "locations": [
    {"code": "P-01", "free": 0, "kind": "pallet", "used": 1, "zone": "inbound", "status": "open", "capacity": 1, "occupants": [{"company": "SHIPBAY", "pallets": 1}], "updated_at": "2026-11-24T09:18:56.090036-05:00", "your_pallets": ["FIX-B-0001"]},
    {"code": "P-02", "free": 0, "kind": "pallet", "used": 1, "zone": "inbound", "status": "open", "capacity": 1, "occupants": [{"company": "SOULED", "pallets": 1}], "updated_at": "2026-11-24T09:18:56.11769-05:00", "your_pallets": []},
    {"code": "P-03", "free": 1, "kind": "pallet", "used": 0, "zone": "inbound", "status": "open", "capacity": 1, "occupants": [], "updated_at": "2026-11-24T09:18:56.004525-05:00", "your_pallets": []},
    "\u2026 66 more"
  ]
}
```

**Change feed as SHIPBAY sees it: its own entry carries the pallet id, the other company's does not** (caller: SHIPBAY)
```
GET /v1/changes?after=0

200
{
  "ok": true,
  "changes": [
    {"v": 1, "at": "2026-11-24T09:18:56.090036-05:00", "seq": 1, "kind": "pallet_assigned", "pallet": "FIX-B-0001", "company": "SHIPBAY", "location": "P-01"},
    {"v": 1, "at": "2026-11-24T09:18:56.11769-05:00", "seq": 2, "kind": "pallet_assigned", "company": "SOULED", "location": "P-02"},
    "\u2026"
  ],
  "last": "<highest seq returned>"
}
```

Feed kinds: `pallet_assigned`, `pallet_moved`, `pallet_released`, `location_changed` (status or capacity; re-read occupancy), `map_changed` (re-read the map), `movements_stopped`, `movements_enabled`, `occupancy_initialized`, `occupancy_reverted`, `nexus_restored`.
Poll with `after=<last seq you processed>`. Numbers only go up; gaps are normal.

### Receiving put-away
**Assign to an empty position** (caller: SOULED)
```
POST /v1/pallets/assign
Idempotency-Key: souled-assign-0001
{"pallet": "MVP-S-1", "to": "P-03"}

200
{
  "ok": true,
  "seq": 7,
  "free": 0,
  "from": null,
  "pallet": "MVP-S-1",
  "location": "P-03"
}
```

**Assign to an occupied position** (caller: SHIPBAY)
```
POST /v1/pallets/assign
Idempotency-Key: shipbay-assign-0001
{"pallet": "MVP-B-1", "to": "P-03"}

409
{
  "ok": false,
  "used": 1,
  "error": "location_full",
  "message": "that location has no room",
  "capacity": 1,
  "location": "P-03"
}
```

**Destination does not exist** (caller: SOULED)
```
POST /v1/pallets/assign
Idempotency-Key: mvp-30
{"pallet": "MVP-S-3", "to": "P-67"}

404
{
  "ok": false,
  "error": "location_not_found",
  "message": "no location with that code"
}
```

**Destination is the dock** (caller: SHIPBAY)
```
POST /v1/pallets/assign
Idempotency-Key: mvp-38
{"pallet": "MVP-B-3", "to": "RCV-DOCK"}

409
{
  "ok": false,
  "error": "location_not_a_destination",
  "message": "that location is not a pallet storage position",
  "location": "RCV-DOCK"
}
```

**Destination blocked** (caller: SHIPBAY)
```
POST /v1/pallets/assign
Idempotency-Key: mvp-4
{"pallet": "MVP-B-11", "to": "P-11"}

409
{
  "ok": false,
  "error": "location_blocked",
  "message": "spill",
  "location": "P-11"
}
```

**Destination not in use** (caller: SOULED)
```
POST /v1/pallets/assign
Idempotency-Key: mvp-3
{"pallet": "MVP-S-10", "to": "P-10"}

409
{
  "ok": false,
  "error": "location_unavailable",
  "message": "rack removed",
  "location": "P-10"
}
```

**Assigning a pallet that is already on the floor** (caller: SOULED)
```
POST /v1/pallets/assign
Idempotency-Key: mvp-49
{"pallet": "MVP-S-1", "to": "P-12"}

409
{
  "ok": false,
  "error": "pallet_elsewhere",
  "message": "that pallet already stands in a location; move it instead",
  "location": "P-07"
}
```


### Moving and releasing
**Move a pallet** (caller: SOULED)
```
POST /v1/pallets/move
Idempotency-Key: souled-move-0001
{"pallet": "MVP-S-1", "to": "P-05", "from": "P-03"}

200
{
  "ok": true,
  "seq": 9,
  "free": 0,
  "from": "P-03",
  "pallet": "MVP-S-1",
  "location": "P-05"
}
```

**A move from where the pallet no longer is** (caller: SOULED)
```
POST /v1/pallets/move
Idempotency-Key: souled-move-0004
{"pallet": "MVP-S-1", "to": "P-12", "from": "P-05"}

409
{
  "ok": false,
  "error": "pallet_elsewhere",
  "message": "the pallet is not where the request says it is",
  "location": "P-07"
}
```

**Moving a pallet that is not on the floor** (caller: SOULED)
```
POST /v1/pallets/move
Idempotency-Key: mvp-53
{"pallet": "MVP-S-GONE", "to": "P-13"}

409
{
  "ok": false,
  "error": "pallet_not_placed",
  "message": "that pallet is not in any location"
}
```

**Moving a pallet Nexus has never seen** (caller: SOULED)
```
POST /v1/pallets/move
Idempotency-Key: mvp-54
{"pallet": "MVP-S-NEVER", "to": "P-13"}

404
{
  "ok": false,
  "error": "pallet_not_found",
  "message": "no pallet with that id for this company"
}
```

**Release a pallet (it leaves the floor)** (caller: SOULED)
```
POST /v1/pallets/release
Idempotency-Key: souled-release-0001
{"pallet": "MVP-S-1", "from": "STG-01"}

200
{
  "ok": true,
  "seq": 12,
  "pallet": "MVP-S-1",
  "released_from": "STG-01"
}
```


### Duplicates and retries
**The same request sent again with the same key** (caller: SOULED)
```
POST /v1/pallets/move
Idempotency-Key: souled-move-0002
{"pallet": "MVP-S-1", "to": "P-06", "from": "P-05"}

200
{
  "ok": true,
  "seq": 14,
  "free": 0,
  "from": "P-05",
  "pallet": "MVP-S-1",
  "location": "P-06",
  "replayed": true
}
```

**The same key for a different request** (caller: SOULED)
```
POST /v1/pallets/move
Idempotency-Key: souled-move-0003
{"pallet": "MVP-S-1", "to": "P-08", "from": "P-07"}

409
{
  "ok": false,
  "error": "idempotency_key_reused",
  "message": "this key was already used for a different request"
}
```

**Nexus could not complete the request** (caller: SOULED)
```
POST /v1/pallets/move
Idempotency-Key: souled-move-int-1
{"pallet": "MVP-S-INT", "to": "P-29", "from": "P-30"}

503
{
  "ok": false,
  "error": "unavailable",
  "message": "Nexus could not answer. Nothing was changed; send the same request again with the same Idempotency-Key."
}
```

**What happened to my request? The caller's own history** (caller: SOULED)
```
GET /v1/moves?pallet=MVP-S-INT

200
{
  "ok": true,
  "moves": [
    {"at": "2026-11-24T09:18:56.917431-05:00", "id": 71, "to": "P-29", "from": "P-30", "kind": "move", "pallet": "MVP-S-INT", "result": "ok"},
    {"at": "2026-11-24T09:18:56.788518-05:00", "id": 70, "to": "P-30", "from": null, "kind": "assign", "pallet": "MVP-S-INT", "result": "ok"}
  ]
}
```


### Company boundaries
**Moving the other company's pallet** (caller: SHIPBAY)
```
POST /v1/pallets/move
Idempotency-Key: mvp-57
{"pallet": "FIX-S-0001", "to": "P-20", "from": "P-02"}

404
{
  "ok": false,
  "error": "pallet_not_found",
  "message": "no pallet with that id for this company"
}
```

**Asking for the other company's pallet history** (caller: SHIPBAY)
```
GET /v1/moves?pallet=FIX-S-0001

200
{
  "ok": true,
  "moves": []
}
```

**A key without the move scope** (caller: SOULED (read-only key))
```
POST /v1/pallets/move
Idempotency-Key: mvp-63
{"pallet": "FIX-S-0001", "to": "P-21"}

403
{
  "ok": false,
  "error": "forbidden",
  "message": "this key does not have the move scope"
}
```

**Any movement on a floor that is not initialized** (caller: SOULED (real-floor key))
```
POST /v1/pallets/assign
Idempotency-Key: mvp-65
{"pallet": "REAL-1", "to": "P-03"}

423
{
  "ok": false,
  "error": "occupancy_not_initialized",
  "message": "Assign, move and release are switched off on this floor until its occupancy baseline is entered and verified.",
  "occupancy_state": "not_initialized"
}
```


## Not in the MVP
Choosing a location for you. Quantities or contents. Webhooks (poll `/v1/changes`). Looking up a request by its key (resend it instead).
The full reference, including the calendar calls, is `neutral/API.md`.
