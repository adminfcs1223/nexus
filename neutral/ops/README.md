# Nexus backup and recovery

Three files. `backup.sh` reads a database and writes a backup directory. `restore-verify.sh` restores a backup into a
brand-new database, verifies it and locks it. `lib.sh` holds the digest queries both use. Nothing is installed in the
database being backed up, and nothing is ever restored into an existing database.

## What a backup holds
Everything in the `nexus` schema: floors and their lock state, the location registry and map, companies, pallets,
occupancy, movement history with its idempotency keys, the change feed, calendar events, baselines with their approvals,
unlock approvals, discrepancies, the audit log, and every function and constraint.

Never: `key_handoff` rows (temporary plaintext pickup). By default also not the key hashes and operator token hashes;
`--with-credentials` includes those for a real recovery, and that backup must be stored like a credential store.

## Rehearsal (safe to repeat; uses a scratch server, never the source)
    neutral/ops/backup.sh "<source-db-url>" /secure/dir/nexus-YYYYMMDD
    neutral/ops/restore-verify.sh /secure/dir/nexus-YYYYMMDD "<scratch-server-url>"
Pass = the last line reads `RESTORE VERIFIED AND LOCKED` and the exit code is 0. The scratch database is dropped at the end.

## What restore-verify checks
1. Every table matches the backup's manifest row for row; functions and constraints are the ones backed up.
2. Then it locks: movements off on every real floor, every unlock go voided, the feed numbered a million ahead with a
   `nexus_restored` entry per floor, and an audit entry. A restored database is always locked, whatever state the backup
   was taken in.
3. Then: no pickup rows; credentials as the mode promises; baselines match their fingerprints; no position over capacity;
   each pallet in one place on its own floor; one history row per idempotency key; counters ahead of the data; every
   recorded movement request sent again moves nothing.
A failure at step 1 stops everything: the database is dropped and must not be used.

## Real recovery, in order
1. Stop: switch movements off on the damaged database if it still answers (`nexus.floor_stop`), and each WMS switches its
   own Nexus movement off.
2. Choose the backup: the newest `--with-credentials` backup taken with these scripts, or the platform's own backup
   restored into a NEW project. Never restore in place over the only copy.
3. Restore into a new database and run `restore-verify.sh` with `KEEP=1`. Do not go on unless it says VERIFIED AND LOCKED.
4. Work out what was lost: everything accepted after the backup's `taken_at`. Each WMS lists its movements since that
   time from its own journal.
5. Each WMS re-sends those movements with their ORIGINAL idempotency keys once the floor reopens. A request the backup
   already held is answered as a replay; one it never saw is carried out once. Each WMS also re-reads the map and
   occupancy in full (the `nexus_restored` feed entry is the signal).
6. Walk the positions touched since the backup. The floor is the truth; differences are opened as discrepancies.
7. Point the service at the restored database.
8. Reopen only through the normal controls: no open discrepancies, a fresh go from each company, then unlock.

## What an administrator verifies before resuming movements
- `restore-verify.sh` passed on this exact database.
- Movements are off on every real floor and no go from before the restore is being counted.
- The backup's `taken_at`, and that both companies know everything after it must be re-sent or re-checked.
- Occupancy for the positions touched since the backup has been checked on the floor.
- Each WMS has re-read the map and occupancy and reset its feed position.
- Open discrepancies: none.
- Fresh go from Souled and from ShipBay, recorded after the restore.

## Data-loss exposure
- With daily platform backups only: up to a day of movements, calendar changes and approvals.
- With these scripts: everything since the last run. Run one immediately before any initialization or unlock.
- A movement lost this way is recoverable when the WMS still has it in its own journal and re-sends it with the same key.
  It is not recoverable from Nexus alone.
- An approval or a baseline recorded after the backup is lost and must be given again.

## Before running against a hosted database
- `pg_dump` and `pg_restore` of the server's major version or newer (the hosted staging database is PostgreSQL 17).
- The direct database connection string, held by the person running it, never pasted into chat or committed.
- A scratch PostgreSQL server that is not the source: a local one, or a new throwaway project.
- An encrypted place for the backup directory if `--with-credentials` is used.
