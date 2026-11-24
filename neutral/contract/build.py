# Builds neutral/MVP-CONTRACT.md from the request/response pairs the acceptance test recorded:
#   NEXUS_EXAMPLES=neutral/contract/examples.json node --test neutral/test/mvp-acceptance.test.mjs && python3 neutral/contract/build.py
import json, os
here = os.path.dirname(__file__); ex = {e['note']: e for e in json.load(open(os.path.join(here, 'examples.json')))}
def fmt(r):
    if not isinstance(r, dict): return json.dumps(r)
    out = []
    for k, v in r.items():
        if isinstance(v, list) and v and len(json.dumps(v)) > 100: out.append(f'  {json.dumps(k)}: [\n' + ',\n'.join('    ' + json.dumps(i) for i in v) + '\n  ]')
        else: out.append(f'  {json.dumps(k)}: {json.dumps(v)}')
    return '{\n' + ',\n'.join(out) + '\n}'
def show(note, trim=None):
    e = ex[note]; r = e['response']
    if trim: r = trim(r)
    head = e['request'] + (f"\nIdempotency-Key: {e['idempotency_key']}" if e.get('idempotency_key') else '') + (f"\n{json.dumps(e['body'])}" if e.get('body') else '')
    return f"**{note}** (caller: {e['caller']})\n```\n{head}\n\n{e['status']}\n{fmt(r)}\n```\n"
def map_trim(r):
    r = dict(r); pos = r['positions']; pick = [p for p in pos if p['code'] in ('P-01', 'P-31', 'STG-01', 'RCV-DOCK')]
    r['positions'] = pick + [f"… {len(pos) - len(pick)} more"]; r['landmarks'] = r['landmarks'][:1] + ['… 4 more']; return r
doc = f"""# Nexus MVP contract for Souled and ShipBay (2026-11-24)

What Nexus does: one shared registry of physical locations on the Hillsborough floor and which company's pallet stands where.
What Nexus does not hold: products, SKUs, quantities, orders, customers, costs. Those stay in each company's own system.

Every example below is a real request and answer recorded by `neutral/test/mvp-acceptance.test.mjs` on a local copy of
exactly what staging runs. Pallet ids in the examples are made up.

## Connection
- Base URL (staging): `https://ankoqruedjujyefhrmtw.supabase.co/functions/v1/nexus`
- `Authorization: Bearer <key>` on every call except health. Server to server only. A key in the address is refused.
- A key fixes the company, the system and the floor. Nothing in a request can name another company or floor.
- Staging keys are bound to `HILLSBOROUGH-TEST` (synthetic). Scopes: `read`, `move`, `calendar`.
- Every answer is JSON with `ok`. A refusal is `{{"ok": false, "error": "<code>", "message": "…"}}`. Branch on `error`, not on `message`.

## Calls
| Call | Scope | Purpose |
|---|---|---|
| `GET /v1/health` | none | Service is up. |
| `GET /v1/map` | read | Locations, their squares, `map_version`, `checksum`. |
| `GET /v1/occupancy` | read | Every location: status, capacity, used, free, which companies. |
| `POST /v1/pallets/assign` `{{pallet, to}}` | move | Put a pallet that is not on the floor into a location (receiving put-away). |
| `POST /v1/pallets/move` `{{pallet, to, from}}` | move | Move a pallet. Always send `from`. |
| `POST /v1/pallets/release` `{{pallet, from}}` | move | The pallet leaves the floor. |
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
{show('The map', map_trim)}
{show("Occupancy entries as SHIPBAY sees them: its own pallet, the other company's pallet, an empty position")}
{show("Change feed as SHIPBAY sees it: its own entry carries the pallet id, the other company's does not")}
Feed kinds: `pallet_assigned`, `pallet_moved`, `pallet_released`, `location_changed` (status or capacity; re-read occupancy), `map_changed` (re-read the map), `movements_stopped`, `movements_enabled`, `occupancy_initialized`, `occupancy_reverted`, `nexus_restored`.
Poll with `after=<last seq you processed>`. Numbers only go up; gaps are normal.

### Receiving put-away
{show('Assign to an empty position')}
{show('Assign to an occupied position')}
{show('Destination does not exist')}
{show('Destination is the dock')}
{show('Destination blocked')}
{show('Destination not in use')}
{show('Assigning a pallet that is already on the floor')}

### Moving and releasing
{show('Move a pallet')}
{show('A move from where the pallet no longer is')}
{show('Moving a pallet that is not on the floor')}
{show('Moving a pallet Nexus has never seen')}
{show('Release a pallet (it leaves the floor)')}

### Duplicates and retries
{show('The same request sent again with the same key')}
{show('The same key for a different request')}
{show('Nexus could not complete the request')}
{show("What happened to my request? The caller's own history")}

### Company boundaries
{show("Moving the other company's pallet")}
{show("Asking for the other company's pallet history")}
{show('A key without the move scope')}
{show('Any movement on a floor that is not initialized')}

## Not in the MVP
Choosing a location for you. Quantities or contents. Webhooks (poll `/v1/changes`). Looking up a request by its key (resend it instead).
The full reference, including the calendar calls, is `neutral/API.md`.
"""
open(os.path.join(here, '..', 'MVP-CONTRACT.md'), 'w').write(doc)
