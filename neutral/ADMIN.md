# Nexus administrator controls (draft 1.0.0, 2026-11-23)

Status: built and tested on local scratch databases with synthetic operators and a rehearsal floor. Not deployed anywhere.
Nothing here is reachable from the public integration service.

## Pieces
- `006_admin_controls.sql`: floor assignment for operators, table-level guards, refusal audit, the two service roles, the
  permission audit, the review call, the owner's break-glass stop, rehearsal floors.
- `service/admin.mjs`: the handler. `service/admin-server.mjs`: runs it on Node, bound to 127.0.0.1.
- `test/admin.test.mjs`: 7 tests.

## Calls (all under `/admin/v1/floors/{floor}`; `Authorization: Bearer <operator token>`)
| Call | Role | What |
|---|---|---|
| `GET /status` | any | Lock state, baselines and approvals, unlock gos, open discrepancies, audit trail. |
| `POST /baselines` `{report}` | initialize or approve | Submit a passing validator report. |
| `GET /baselines/{id}` | any | Review: fingerprint, checks re-run now, counters, occupied positions, approvals. |
| `POST /baselines/{id}/approve` `{fingerprint}` | approve (company) | One approval per company; never the submitter. |
| `POST /baselines/{id}/reject` `{reason}` | approve or initialize | |
| `POST /baselines/{id}/initialize` `{fingerprint, backup}` | initialize | Needs every company's approval. Leaves movements off. |
| `POST /baselines/{id}/revert` `{reason}` | initialize | Only while movements were never switched on since. |
| `POST /unlock-approval` | approve (company) | That company's go. Sent again, it is not counted twice. |
| `POST /unlock` `{confirm: "UNLOCK <floor>"}` | unlock | Needs verified capacities, no open discrepancy, a live go from each company. |
| `POST /stop` `{reason}` | stop | Immediate. Cancels every go. |
| `POST /capacity` `{position, capacity, specification}` | registry | |
| `POST /discrepancies`, `POST /discrepancies/{n}/resolve` | see 004 | |

## Where each rule is enforced
| Rule | Enforced by |
|---|---|
| Who the operator is, their roles, their floors | Database functions (`_op`, `_floor_gate`), from the token alone. |
| Synthetic operators only on rehearsal floors; real operators never on them | Database (`_floor_gate`), plus `operator_create`. |
| Synthetic-mode service serves REHEARSAL- floors only | The handler refuses to start otherwise and checks the floor in every address first. |
| No self-approval; one approval per company; same fingerprint | `baseline_approve`. |
| Initialize and unlock are different roles | Role check in each function. |
| A real floor is marked verified only by initializing an approved baseline | Trigger on the floor row. |
| Movements switched on only by the unlock control | Trigger on the floor row (plus the earlier CHECK). |
| Any switch-off cancels every go and is recorded | Trigger on the floor row: true for the stop control, the break-glass stop and a plain UPDATE. |
| Only the two service roles can run anything; each only its own calls | Grants, SECURITY DEFINER on service calls, `permission_audit()`. |

## Stop without the administrator interface
1. Any operator with the stop role, by direct database call: `select nexus.floor_stop('<token>', '<floor>', '<reason>')`.
2. The database owner, no token: `select nexus.break_glass_stop('<floor>', '<reason>')`.
3. The database owner, bare SQL: `update nexus.warehouses set moves_enabled = false where code = '<floor>'`.
All three cancel every go and write the audit trail. Reopening always needs a fresh go from each company and the unlock control.

## Not built
- A screen. This is an API; a person needs a tool that can send HTTPS requests with a header, or a small page on top of it.
- Hosting. The server binds to 127.0.0.1. Publishing it needs a decision on where, behind what network restriction, and
  rate limiting, none of which exists.
- Operator tokens are long-lived bearer tokens with no expiry, no rotation and no second factor.
- On staging the integration service still connects as the database owner, not as `nexus_api`.
