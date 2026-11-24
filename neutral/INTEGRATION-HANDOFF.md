# Nexus integration handoff for the Souled and ShipBay developers (2026-11-24)

Reference: `neutral/MVP-CONTRACT.md` at commit `663767e` (recorded request and answer examples). This page is the short form.

Nexus holds one thing: which company's pallet stands at which physical location. It holds no products, quantities or orders.

## Connection
- Base URL (staging): `https://ankoqruedjujyefhrmtw.supabase.co/functions/v1/nexus`
- Header on every call: `Authorization: Bearer <your key>`. Server side only; never in a browser or in the address.
- Your key fixes your company and your floor (`HILLSBOROUGH-TEST` on staging). Nothing in a request can name another company or floor.
- Reads need the `read` scope; assign, move and release need the `move` scope (your movement key).

## Endpoints
| Method and path | Body | Purpose |
|---|---|---|
| `GET /v1/map` | none | Locations, their squares, `map_version`, `checksum`. |
| `GET /v1/occupancy` | none | Every location: `status`, `capacity`, `used`, `free`, `occupants`, `your_pallets`. |
| `POST /v1/pallets/assign` | `{"pallet": "<your id>", "to": "P-03"}` | Put a pallet that is not on the floor into a location. |
| `POST /v1/pallets/move` | `{"pallet": "<your id>", "to": "P-05", "from": "P-03"}` | Move a pallet. |
| `POST /v1/pallets/release` | `{"pallet": "<your id>", "from": "P-05"}` | The pallet leaves the floor. |
| `GET /v1/moves?pallet=<your id>` | none | Your own request history, refusals included. |
| `GET /v1/changes?after=<seq>` | none | Numbered feed of floor changes. |

Required on every `POST`: header `Idempotency-Key` (1 to 128 characters), `pallet`, and `to` (assign, move).
`from` is required by this contract on move and release: Nexus accepts a request without it, but then a stale screen is not caught. Always send it.

## Answers
- Success: HTTP 200, `{"ok": true, "pallet": "…", "location": "P-05", "from": "P-03", "free": 0, "seq": 9}`. Release returns `released_from` in place of `location`.
- Refusal: `{"ok": false, "error": "<code>", "message": "…"}`, sometimes with `location`, `capacity`, `used`. Branch on `error`, never on `message`.
- A replayed answer is the original answer plus `"replayed": true`.

## Idempotency
- One key per intended operation. Create it once, store it with your own record of the operation, reuse it for every retry of that operation.
- Same key, identical request: the first answer again, `"replayed": true`. Nothing happens twice.
- Same key, different pallet, action, `to` or `from`: 409 `idempotency_key_reused`.
- A refusal is kept under its key permanently. A new attempt after a refusal needs a new key.
- 400, 401, 403, 423 and 503 are not kept: resend with the same key.

## What your WMS must do with each answer
The rule under all of these: your own pallet location changes only after Nexus answers 200. On anything else it stays as it was.

| HTTP | `error` | Your WMS must |
|---|---|---|
| 200 | none | Record the placement. If `replayed` is true, do not apply it a second time. |
| 400 | `bad_request` | Not retry. Fix the request (missing pallet, key or body). |
| 401 | `unauthorized` | Stop and alert: the key is wrong or deactivated. |
| 403 | `forbidden` | Stop: this key has no `move` scope. Use the movement key. |
| 404 | `location_not_found` | Not retry. Refresh the map; the code does not exist. |
| 404 | `pallet_not_found` | Not retry. Your company has no such pallet in Nexus; assign it first. |
| 409 | `location_full` | Leave the pallet where it is. Offer another position. New key for the new attempt. |
| 409 | `location_not_a_destination` | Same as above. `RCV-DOCK` is never a destination. |
| 409 | `location_blocked`, `location_unavailable` | Same as above. Show `message` to the operator. |
| 409 | `pallet_elsewhere` | Your record is stale. Refresh occupancy (the answer carries the true `location`), then retry with a new key if still wanted. |
| 409 | `pallet_not_placed` | The pallet is known but not on the floor. Assign it. |
| 409 | `already_there` | Nothing to do. |
| 409 | `idempotency_key_reused` | A bug on your side: a key was reused for a different operation. Do not retry blindly. |
| 423 | `occupancy_not_initialized` | Stop. The floor is locked. No automatic retry. |
| 503 or timeout | `unavailable` | Resend the identical request with the same key until you get an answer. Nothing is half-done. |
| any other | unknown code | Treat as a refusal: nothing changed. |

## Privacy
You see your own pallet ids in `your_pallets`, `/v1/moves` and `/v1/changes`. The other company appears as a company name and a count. A request about the other company's pallet answers `pallet_not_found`.

## Switches
Nexus has its own movement switch per floor. On staging it is ON for `HILLSBOROUGH-TEST` and OFF for the real floor `HILLSBOROUGH`.
Each WMS also has its own, independent switch that decides whether it sends movements to Nexus at all. Nexus cannot see or change those.
A movement happens only when the sending WMS's switch is on and Nexus's floor switch is on.
