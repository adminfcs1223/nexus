# Nexus integration API, v1 (draft 1.0.0, 2026-11-22)

Status: running on the Nexus staging project. Souled's development environment has connected and passed its first tests.
No production system calls it.

## Staging
- Base URL: `https://ankoqruedjujyefhrmtw.supabase.co/functions/v1/nexus` (so the map is `GET <base>/v1/map`).
- Staging keys are bound to the test floor `HILLSBOROUGH-TEST`: the canonical map with synthetic data only.
- Each system keeps its key in a server-side secret named `NEXUS_STAGING_API_KEY`, in an environment that is not its production backend.
- Each company has two staging keys: one with `read` and `calendar`, one with `read` and `move`. `POST /v1/pallets/*` answers 403 for a key without `move`.
- The short version for both teams, with recorded request and answer examples, is `MVP-CONTRACT.md`.

## Rules
- Every path starts with `/v1`. A change that would break a caller becomes `/v2`; `/v1` keeps working alongside it.
- Server to server only. `Authorization: Bearer <key>`. A key in the address is refused. A key never belongs in a browser.
- A key belongs to one company, one system and one floor (the live floor or the test floor) and carries scopes: `read`, `move`, `calendar`.
  Who the caller is comes from the key and from nothing in the request.
- Every answer is JSON with `ok`. A refusal is `{"ok": false, "error": "<code>", "message": "…"}`.
- `POST /v1/pallets/*` needs an `Idempotency-Key` header (1 to 128 characters). One key per intended operation:
  - Same key + the identical request (action, pallet, and the positions that matter: assign `to` · move `to` and `from` ·
    release `from`; case and surrounding spaces ignored): the first answer again with `"replayed": true`. Nothing moves.
  - Same key + a different action, pallet, source or destination, including leaving out a `from` that was sent before: 409
    `idempotency_key_reused`. Nothing moves.
  - A refusal (for example `location_full`) is kept under its key: the same key keeps answering that refusal even after the
    floor changes. A new attempt needs a new key.
  - Keys are scoped to one credential and are kept with the movement history permanently; there is no expiry.
  - Not kept, so safe to resend with the same key: 400, 401, 403, 423 and 503 answers.
  - Requests recorded before 2026-11-23 are matched on action and pallet only.
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

## Drawing the map (`GET /v1/map`, map version 4)
Final approved layout (version 4 moved staging to sit directly beneath P-15 and P-30; numbering unchanged): `P-01` to `P-66` with no gaps, plus `STG-01` and `STG-02`. Draw from the response, never from a hard-coded list.
- `layout.grid`: 5 columns by 18 rows, origin top-left, `x` left to right, `y` top to bottom.
- `layout.blocks`: outbound `x` 1-2, `y` 1-18 · walkway `x` 3 · inbound `x` 4-5, `y` 1-15 · staging `x` 4-5, `y` 16 (directly beneath P-15 and P-30).
- Each position has `code`, `kind`, `block`, `x`, `y` (its square on that grid), `capacity`, `status`. `RCV-DOCK` is the dock itself: no square, do not draw it as a pallet position.
- `landmarks`: Exit top-left, Dock top-right, Walkway centre, Entrance bottom-centre, Prep area bottom-right; each has `at`, and `edge` + `x` where it sits on the top or bottom edge.
- `map_version` and `checksum`: store them. A `map_changed` entry in `/v1/changes`, or a different checksum, means fetch the map again.
- Current staging value: version 4, checksum `be3cc8f3e9134cb4dfe7d3ac41773bc5d231ed56b4a42c05f5939467d67c8c4f`.

## Reading occupancy (`GET /v1/occupancy`) next to the map
- The answer lists EVERY location in the floor's registry, occupied or not: the same codes as the map's `positions` plus
  any in the map's `not_drawn` list (empty on map version 4).
  On map version 4 that is 69: the 68 put-away destinations (`P-01` to `P-66`, `STG-01`, `STG-02`) and `RCV-DOCK`.
- A put-away destination is a map position that has a square (`x` and `y`). `RCV-DOCK` has `kind: "dock"` and no square:
  it is in the registry, it is not a destination, and it is normally empty (`used: 0`).
- Validate against the map answer, not against a fixed list of 68: every occupancy code must be one of the map's
  `positions`; every map position must appear; a location with no square must have `used: 0`. Treat an unknown code, a
  missing position, or a pallet standing on a location with no square as an error. Do not drop entries you do not draw.
- `capacity` and `free` are `null` where no limit is set (today `STG-01`, `STG-02`, `RCV-DOCK`).
- Each entry: `code, kind, zone, status, capacity, used, free, occupants[{company, pallets}], your_pallets[], updated_at`.
  `your_pallets` holds only the caller's own pallet ids; another company appears in `occupants` as a name and a count.
- A reference implementation of this check is `neutral/client/occupancy-check.mjs`.

## Error codes
| HTTP | Codes |
|---|---|
| 400 | `bad_request`, `location_not_confirmed` (forward-only floor: send `confirmed_empty: true` and `confirmed_by`; see `PRODUCTION-CONNECTION.md`) |
| 401 | `unauthorized` |
| 403 | `forbidden` (key lacks the scope) |
| 404 | `pallet_not_found`, `location_not_found`, `not_found` |
| 409 | `location_not_a_destination` (the location exists but has no square on the map, e.g. `RCV-DOCK`; on staging since 2026-11-23), `location_full`, `location_blocked`, `location_unavailable`, `pallet_elsewhere`, `pallet_not_placed`, `already_there`, `idempotency_key_reused` |
| 423 | `occupancy_not_initialized` (the floor's baseline is not verified; assign, move and release are off) |
| 503 | `unavailable` (nothing was changed; retry with the same key) |

## Feed entries a system must act on
- `map_changed`: fetch the map again.
- `occupancy_initialized`, `occupancy_reverted`: a floor's baseline was entered or taken back; read occupancy again in full.
- `movements_stopped`, `movements_enabled`: the floor was locked or reopened.
- `nexus_restored`: Nexus was recovered from a backup. Read the map and occupancy again in full, treat every movement sent
  since the time your own records show Nexus last confirmed as unconfirmed, and re-send those with their original
  Idempotency-Key once the floor reopens. Feed numbers jump far ahead after a restore; keep reading from your last number.

## Not in v1 yet
Push notifications (webhooks): a system polls `/v1/changes`. People's sign-in and the admin screens. Baseline entry tools.
