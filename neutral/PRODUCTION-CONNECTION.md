# Nexus real-floor connection (HILLSBOROUGH) — for the Souled and ShipBay developers (2026-11-24, forward-only launch)

Status: LIVE. The real floor is open in forward-only mode: it started blank and is filled only by real receiving.

- Endpoint: `https://ankoqruedjujyefhrmtw.supabase.co/functions/v1/nexus` (the key decides the floor). API version `1.1.0`.
- Floor: `HILLSBOROUGH`. Map version 4, 69 locations. Checksum `be3cc8f3e9134cb4dfe7d3ac41773bc5d231ed56b4a42c05f5939467d67c8c4f`.
- `occupancy_state: "forward_only"`, `moves_enabled: true`.
- The test floor `HILLSBOROUGH-TEST` is retired (2026-11-24). Every staging key now answers 401; remove `NEXUS_STAGING_API_KEY` from use.
- Everything in `neutral/INTEGRATION-HANDOFF.md` (commit `a465b55`) still applies. This page adds the one new rule.

## The one new rule: confirm the location before placing
Blank in Nexus does not mean empty on the floor: stock that was never recorded may be standing there.
On this floor every `assign` and every `move` must carry two extra fields, sent only after a person has looked at the destination:

```
POST /v1/pallets/assign
Idempotency-Key: <one per operation>
{"pallet": "<your id>", "to": "P-14", "confirmed_empty": true, "confirmed_by": "<name or staff id of who checked>"}
```
- `confirmed_empty` must be the JSON boolean `true`. `confirmed_by` is 2 to 80 characters.
- Missing or wrong: HTTP 400 `location_not_confirmed`. Nothing is recorded; resend with the same key once confirmed.
- Your screen must make the employee confirm the specific position each time. Do not send `true` by default.
- If the position physically holds unrecorded stock, do not place there. Pick another position.
- A confirmation never overrides Nexus: an occupied position still answers 409 `location_full`.
- `release` needs no confirmation. `from` is still required by contract on move and release.
- Nexus stores who confirmed with the movement. The other company never sees it.

## Credentials
Per company, bound to `HILLSBOROUGH`: one movement key (read + move) in the server-side secret `NEXUS_PRODUCTION_API_KEY`, and
one read-only key in `NEXUS_PRODUCTION_READ_KEY`.
Keys are issued by the owner, one at a time, with `select nexus.credential_issue_once('<COMPANY>', 'movement' | 'read');` in the
Nexus database's SQL editor. The key is shown once in that answer and is not stored anywhere in readable form.
Copy it straight into the server-side secret. Never into chat, an AI assistant, email, a repository, a URL, browser code or logs.
The first set of keys (issued 2026-11-24) is being replaced; each old key is retired once its replacement is seen working.

## Connection requirements
1. Server-to-server HTTPS only, `Authorization: Bearer <key>`.
2. On every start check `warehouse` is `HILLSBOROUGH`, `map_version` 4 and the checksum above. Stop on a mismatch.
3. Draw the map from `GET /v1/map`, occupancy from `GET /v1/occupancy`, and poll `GET /v1/changes`.
4. A 423 `occupancy_not_initialized` means the floor has been stopped. Stop sending and tell the operator.
