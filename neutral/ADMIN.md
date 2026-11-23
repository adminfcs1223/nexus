# Nexus administrator access (draft 2.0.0, 2026-11-23)

Status: built and tested on local scratch databases with synthetic operators and a rehearsal floor. **Not deployed anywhere.**
Nothing here is reachable from the public integration service. No real operator, credential or break-glass code exists.

## Pieces
| File | What |
|---|---|
| `006_admin_controls.sql` | Floor-assigned operators, table-level lock guards, the thirteen controls, rehearsal floors. |
| `008_admin_hardening.sql` | Sessions, authenticator codes, the single entry point and access log, role separation, append-only audit and checkpoints, break-glass codes, operator management, three service roles. |
| `009_owner_role.sql` | Moves the schema to an owner nobody can log in as; closes the default-permission gap. |
| `service/admin.mjs`, `service/admin-server.mjs` | The service: network allow-list, HTTPS, request limits, then the database. Binds to 127.0.0.1. |
| `test/hardening.test.mjs` | 8 tests of everything on this page. `test/admin.test.mjs` (7 tests) still covers the 006 database rules through the retired first handler in `test/legacy/`. |

## How a person uses a control
1. **Sign in**: `POST /admin/v1/session {credential, code}`. The credential is long-lived and personal; the code is from their authenticator app. Answer: a session token, valid 15 minutes.
2. **Call controls** with `Authorization: Bearer <session>` under `/admin/v1/floors/{floor}/…` (same paths as before).
3. **Approve, give a go, initialize, revert, unlock** need a code entered in the last 5 minutes. If it is older: `403 mfa_required`, then `POST /admin/v1/session/confirm {code}`.
4. **Stop** needs only a live session with the stop role. It never waits for a code.
5. **Sign out**: `DELETE /admin/v1/session`.

The long-lived credential runs nothing by itself, at the service or straight at the database.

## What ends a session
Fifteen minutes; sign-out; a newer sign-in by the same operator; revocation by the operator manager; deactivation; a replaced
credential or authenticator; five wrong codes in a row (which also locks sign-in for 15 minutes); use from a different network
address than it was opened from. Each is checked in the database on every call, so it takes effect on the next request.

## Multi-factor approach
Built: a credential (something the person holds in a password manager) plus time-based one-time codes (RFC 6238, six digits,
30 seconds, any authenticator app). Codes are verified in the database; each code works once; a wrong code counts toward the lock.

Known weakness: a typed code can be relayed by a convincing fake page while it is still valid. The allow-list and the
address-bound session narrow that, they do not remove it. The alternatives, for the owner to choose between:
| Option | For | Against |
|---|---|---|
| Authenticator codes (built) | Works today, no vendor, no browser needed. | Can be phished in real time; secret sits in the database. |
| Passkeys / hardware security keys | Cannot be phished; nothing secret stored server-side. | Needs a browser screen and a fixed web address; more to build. |
| Company sign-in (Google Workspace or similar) in front of the service | People already have it; their MFA and offboarding apply. | Ties a neutral system to one company's identity provider unless both are federated. |

## Who can do what
| Authority | Held by | Enforced by |
|---|---|---|
| Company approval of a baseline; company go for unlock | An operator with `approve_baseline`, belonging to that company | Role check, company check, never the submitter, fresh code |
| Initialize / revert | An operator with `initialize` | Role check, fresh code, needs every company's approval |
| Unlock | An operator with `unlock` | Role check, fresh code, needs a live go from each company, verified capacities, no open discrepancy, no unreviewed break-glass use |
| Stop | Any operator with `stop` | Role check only |
| Break-glass stop | The named holder of a sealed code | Single-use code for one floor |
| Enrol, revoke, deactivate operators; issue, revoke, review break-glass codes; audit checkpoints | A database login in `nexus_security_admin` | Grants; recorded under that login's own name |
| Migrations; last-resort stop in SQL | The database administrator | Not a Nexus role |

No operator record, and no person across several records, may hold more than one of approve / initialize / unlock. A table
constraint and the enrolment function both enforce it. Stop, registry and view combine with anything.

## Database access
| Login is a member of | Can run | Cannot |
|---|---|---|
| `nexus_api` (integration service) | The 7 integration calls | Anything else; any table |
| `nexus_admin_api` (admin service) | `session_open`, `session_step_up`, `session_close`, `admin_call`, `admin_edge_refusal`, `break_glass_redeem` | Any control directly; any table; operator management |
| `nexus_security_admin` (operator manager) | The 12 management and audit calls | Any control; sign-in; any table, including secrets |

Everything is owned by `nexus_owner`: no login, no password, not a superuser, rights over schema `nexus` only. Service functions
run with its rights on a pinned search path. `permission_audit()` reports any drift (a function with default permissions, a
wrong owner, a service role given a login or more power, a switched-off audit guard).

## Network and request limits (in the service)
- Requests are accepted only from listed networks. There is no default list; a list that admits everyone refuses to start.
- A forwarded address is believed only when the connection comes from one of our own listed proxies.
- Live mode accepts HTTPS only.
- Per minute: 120 requests per address; 5 sign-ins or confirmations per address; 5 break-glass attempts per address; 20 writes and 60 reads per session.
- Refusals made here are written to the access log, at most one row a minute per address and reason.

## Audit
- `audit_log`: events (sign-ins and refusals, approvals, gos, initialize, unlock, stops, enrolments, revocations, break-glass issue / use / refusal / review).
- `admin_access_log`: one row per call the admin service makes, allowed or refused, with request id, control, floor, address, operator, outcome.
- Both are append-only for everyone, the owner included. `audit_checkpoint()` returns a digest; kept outside the database, it shows any later change (`audit_verify()`).
- No credential, session token, authenticator secret or break-glass code is written to either.

## Break-glass stop
For when the people who can stop are not signed in, cannot sign in, or the authenticator path is down.
1. The operator manager issues a code for one floor to a named holder: `select nexus.break_glass_issue('<floor>', '<holder>')`. It is shown once (five groups of five characters); only a hash is kept. Valid 90 days.
2. The holder keeps it sealed (envelope in the warehouse safe, or a password-manager entry only they open).
3. In an emergency: `POST /admin/v1/floors/{floor}/break-glass-stop {code, reason}`. No session, no authenticator. Movements stop at once and every go is cancelled.
4. The code is now spent. A wrong, spent, expired, revoked or other-floor code is refused and recorded.
5. Before the floor can be unlocked again: the operator manager records a review (`break_glass_review`), then a fresh go from each company, then the unlock control.
6. Issue a replacement code.

It can only stop. Last resort if the admin service itself is down: the database administrator runs
`select nexus.break_glass_stop('<floor>', '<reason>')` or a plain `update … set moves_enabled = false`; both cancel every go and are recorded.

## Decisions for the owner
1. **MFA method**: authenticator codes as built, or passkeys / company sign-in before real operators exist.
2. **Strict separation needs at least four named people per floor**: one approver per company, one initializer, one unlocker. I set this as the default because it is the safer reading of the open question; it can be relaxed to allow initialize + unlock in one person, but not by me.
3. **Who is the operator manager** (`nexus_security_admin`). One login can enrol operators for every role, so this person should hold no operator role. Two-person enrolment is not built.
4. **Timings**: 15-minute sessions, 5-minute fresh-code window, 5 wrong codes then a 15-minute lock, 90-day credentials, 90-day break-glass codes (`admin_settings`).
5. **Sessions bound to the network address** they were opened from. Safer; signs out someone whose address changes mid-session.
6. **Allowed networks**: which office or VPN addresses may reach the admin service, and where it is hosted.
7. **Break-glass holders**: who, how many per floor, where the sealed code lives.
8. **Enrolment handoff**: how a credential and authenticator secret reach the person (never chat or email).
9. **Checkpoint digests**: where they are kept outside the database, and how often.
10. **Who holds the database administrator login** once the schema is owned by `nexus_owner`.

## Remaining gaps
- Authenticator secrets are stored unencrypted; the database administrator can read them. Authenticator codes can be phished in real time.
- Request limits live in one process's memory: they reset on restart and do not hold across several instances or a serverless host.
- The operator manager is a single database login with no second factor and no second approver.
- The database administrator can still do anything, including switching guards off. This is detected (checkpoints, permission audit), not prevented.
- `ops/backup.sh` refuses to back up a hardened database until it is taught to leave out the three new secret-bearing tables. A restore made with `--no-owner` needs 009 run again.
- 009 is untested on Supabase, where the administrator login is not a true superuser.
- No alerting on lockouts, refused break-glass attempts or bursts of refusals. No screen. No hosting.
- One fixed 15-minute session length; no separate idle timeout.
- The staging integration service still connects as the database administrator, not as `nexus_api`.
