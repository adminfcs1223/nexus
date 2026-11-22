# Nexus integration API, v1 (draft 1.0.0, 2026-11-22)

Status: built and tested on the Nexus side against a local database with synthetic pallets. Not hosted anywhere yet. Not
yet called by Souled's or ShipBay's real application.

## Rules
- Every path starts with `/v1`. A change that would break a caller becomes `/v2`; `/v1` keeps working alongside it.
- Server to server only. `Authorization: Bearer <key>`. A key in the address is refused. A key never belongs in a browser.
- A key belongs to one company, one system and one floor (the live floor or the test floor) and carries scopes: `read`, `move`, `calendar`.
  Who the caller is comes from the key and from nothing in the request.
- Every answer is JSON with `ok`. A refusal is `{"ok": false, "error": "<code>", "message": "…"}`.
- `POST /v1/pallets/*` needs an `Idempotency-Key` header (1 to 128 characters). The same key sent again returns the first
  answer with `"replayed": true` and changes nothing. On a timeout or a 503, send the same request with the same key.
- Pallet ids are stored exactly as the owning system sends them. Nexus assigns no pallet ids and no format.

## Calls
| Call | Scope | What it does |
|---|---|---|
| `GET /v1/health` | none | Service is up; API version. |
| `GET /v1/map` | read | The floor layout every system draws from: positions with block, column, row; landmarks; `map_version`; `checksum`; `occupancy_state`; `moves_enabled`. |
| `GET /v1/occupancy` | read | Every location: capacity, used, free, which companies stand there (company and count). `your_pallets` lists the caller's own ids only. |
| `GET /v1/changes?after=<seq>&limit=` | read | Numbered feed of every change after `seq`. Own changes carry the pallet or event id; the other company's carry company and location only. |
| `GET /v1/moves?pallet=&before=&limit=` | read | History of the caller's own requests, refused ones included. |
| `POST /v1/pallets/assign` `{pallet, to}` | move | Put a pallet that is not on the floor into a location. |
| `POST /v1/pallets/move` `{pallet, to, from?}` | move | Move it. With `from`, the move is refused if the pallet is not there (stale screen). |
| `POST /v1/pallets/release` `{pallet, from?}` | move | Take it off the floor. |
| `GET /v1/calendar?from=&to=` | read | Dock calendar, both companies. Others' events: company, direction, start, end, pallets, status. |
| `PUT /v1/calendar/{id}` `{direction, starts_at, ends_at?, pallets?, status?, reference?, note?}` | calendar | Create or change the caller's own event, keyed by its own system's id. `reference` and `note` stay with the owner. |
| `DELETE /v1/calendar/{id}` | calendar | Mark the caller's own event cancelled. |

## Error codes
| HTTP | Codes |
|---|---|
| 400 | `bad_request` |
| 401 | `unauthorized` |
| 403 | `forbidden` (key lacks the scope) |
| 404 | `pallet_not_found`, `location_not_found`, `not_found` |
| 409 | `location_full`, `location_blocked`, `location_unavailable`, `pallet_elsewhere`, `pallet_not_placed`, `already_there`, `idempotency_key_reused` |
| 423 | `occupancy_not_initialized` (the floor's baseline is not verified; assign, move and release are off) |
| 503 | `unavailable` (nothing was changed; retry with the same key) |

## Not in v1 yet
Push notifications (webhooks): a system polls `/v1/changes`. People's sign-in and the admin screens. Baseline entry tools.
