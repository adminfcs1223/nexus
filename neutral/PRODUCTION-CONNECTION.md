# Nexus real-floor connection (HILLSBOROUGH) — for the Souled and ShipBay developers (2026-11-24)

Status: READ connection live. Movements LOCKED until the physical count is entered and approved by both companies.

- Endpoint: `https://ankoqruedjujyefhrmtw.supabase.co/functions/v1/nexus` (same service as the test floor; the key decides the floor).
- Contract: `neutral/INTEGRATION-HANDOFF.md` at commit `a465b55`. API version `1.0.0-draft`.
- Floor: `HILLSBOROUGH`. Map version 4. Checksum `be3cc8f3e9134cb4dfe7d3ac41773bc5d231ed56b4a42c05f5939467d67c8c4f`.
- State today: `occupancy_state: "not_initialized"`, `moves_enabled: false`, every location empty in Nexus.
  Empty here means "not counted yet", not "free". Do not offer any position as available until `occupancy_state` is `verified`.

## Credentials
- One read-only key per company, bound to `HILLSBOROUGH`, scope `read`. SHA-256 prefix: Souled `980ee00c`, ShipBay `dbb2fb38`.
- The owner copies each key from the Nexus pickup table into that company's server-side secret `NEXUS_PRODUCTION_API_KEY`.
  Never in chat, email, a repository, a URL, browser code or logs. Keep it apart from `NEXUS_STAGING_API_KEY`.
- After install, the pickup row is deleted; Nexus keeps only the hash.
- Movement keys for this floor are issued after the baseline is approved.

## Connection requirements
1. Server-to-server HTTPS only, `Authorization: Bearer <key>`.
2. Select the floor by which secret you use; never mix staging and production keys or data.
3. Check on every start: `warehouse` is `HILLSBOROUGH`, `map_version` 4, checksum as above. Stop on a mismatch.
4. Any `POST /v1/pallets/*` answers 403 with the read key, and 423 `occupancy_not_initialized` with any key while the floor is locked. Treat both as "nothing changed".
5. Poll `GET /v1/changes`; `occupancy_initialized` and `movements_enabled` announce the baseline and the unlock.
