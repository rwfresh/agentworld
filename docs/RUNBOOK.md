# AgentWorld Operations Runbook

**Applies to:** open-source beta, local Compose, and reference Render deployment
**Primary authority:** PostgreSQL
**Default hosted region:** Render Ohio

This runbook favors preserving economic integrity over accepting traffic. If an
incident could duplicate or destroy state, pause the affected mutation class or
all world mutations before investigating. Never “repair” balances without a
reviewed ledger-backed operation and audit record.

## Local environment

### Start

```console
cp .env.example .env
docker compose up --build
```

Compose runs these services:

| Service | Host endpoint | Purpose |
|---|---|---|
| `api` | <http://localhost:3000> | Game API and auth UI |
| `worker` | none | Polls PostgreSQL for construction, trade expiry, and season cutoff work |
| `postgres` | `127.0.0.1:5432` | Authoritative state and durable work schedules |
| `valkey` | `127.0.0.1:6379` | Shared coarse request-rate-limit counters |
| `mailpit` | <http://localhost:8025>, SMTP `127.0.0.1:1025` | Captured development email |
| `migrate` | one-shot | Applies checked-in migrations |
| `seed` | one-shot | Ensures one current season, private-seeded map, and public OAuth client metadata |

Verify:

```console
docker compose ps
curl --fail http://localhost:3000/health
curl --fail http://localhost:3000/ready
docker compose logs --tail=100 api worker
```

`/health` only reports process liveness. `/ready` verifies coherent
installation/world/map bootstrap, Valkey responsiveness when configured, and
the enabled CLI OAuth client/resource link. It does not yet compare the exact
migration head; retain that as a deployment check.

### Common local operations

```console
# Follow application logs
docker compose logs --follow api worker

# Rebuild application containers after dependency/source changes
docker compose up --build --detach api worker

# Re-run idempotent migrations and seed
docker compose run --rm migrate
docker compose run --rm seed

# Stop but retain database/mail volumes
docker compose down
```

The following destroys the local PostgreSQL and Mailpit volumes. It cannot be
recovered unless you made a separate backup:

```console
docker compose down --volumes
```

Never run that command against an environment whose data matters.

## Configuration

Configuration is validated before serving traffic. Production must fail startup
on an absent or unsafe required value.

| Variable | Required | Production guidance |
|---|---|---|
| `NODE_ENV` | yes | `production` |
| `HOST` / `PORT` | yes | `0.0.0.0` and platform-provided port |
| `DATABASE_URL` | yes | Internal TLS-capable PostgreSQL 15+ connection; least privilege. Production fails startup without it; outside production an absent value falls back to the local Compose connection string |
| `DATABASE_POOL_SIZE` | optional | Positive integer maximum of pooled connections per process (default 10); any other value fails startup |
| `REDIS_URL` | hosted/multi-replica | Shared request-rate-limit store; omission falls back to per-process counters |
| `BASE_URL` | yes | Exact public HTTPS origin; no path/trailing ambiguity |
| `AUTH_SECRET` | yes | Unique random 256-bit value; shared by API/worker, secret store only |
| `WORLD_SEED_SECRET` | yes | Separate random 256-bit key; derives unpredictable reproducible per-season seeds and must never be published |
| `METRICS_TOKEN` | hosted metrics | Random bearer credential required by `/metrics` in production |
| `AUTH_MODE` | yes | `better-auth`; development mode must be rejected off loopback |
| `REGISTRATION_MODE` | yes | `invite` for hosted beta; `open`, `invite`, or `closed` |
| `RULESET_PATH` | yes | Immutable checked-in beta ruleset path |
| `GITHUB_CLIENT_ID/SECRET` | provider-dependent | OAuth app with exact production callback |
| `SMTP_URL` / `EMAIL_FROM` | email-dependent | Transactional provider URL and verified sender |
| `WORKER_POLL_INTERVAL_MS` | optional | Worker poll interval in milliseconds; default 1000, also the floor of the failure backoff |
| `WORKER_BATCH_SIZE` | optional | Maximum due rows the worker claims per job kind per poll; default 100 |

Do not store secrets in `.env.example`, Compose, the Render Blueprint, logs, or
the repository. `BASE_URL`, OAuth callbacks, cookie security, proxy trust, and
TLS must be reviewed together whenever a domain changes.

PostgreSQL 15 is the minimum supported server version because migration `002`
uses `ON DELETE SET NULL (column_list)`; the Compose stack and Render Blueprint
provision PostgreSQL 18. Size `DATABASE_POOL_SIZE` per process so API replicas,
the worker, migrations, and operator sessions together stay under the server's
connection limit.

Gameplay balance is not ordinary environment configuration. The document at
`RULESET_PATH` is validated, normalized, persisted, and hashed when a world is
seeded; thereafter the stored ruleset is authoritative. Create a new season
rather than changing an active world's balance.

## Registration invitations

Hosted deployments default to `REGISTRATION_MODE=invite`; local development
defaults to `open`. After migrations have completed, create an invitation from
a trusted operator shell with database access:

```console
INVITE_CREATED_BY=ops-primary \
  pnpm --filter @agentworld/server auth:invite:dev \
  --max-uses 1 --expires-in-hours 168
```

For a built image, including a Render one-off shell, use:

```console
INVITE_CREATED_BY=ops-primary node apps/server/dist/create-invite.js \
  --max-uses 1 --expires-in-hours 168
```

`INVITE_CREATED_BY` is a stable, non-email operator identifier. Command-line
values override `INVITE_CREATED_BY`, `INVITE_MAX_USES`, and
`INVITE_EXPIRES_HOURS`; `--json` emits a single machine-readable result. The
defaults are one use and seven days, and both limits are required and bounded.

The command generates a 120-bit human-readable code, stores only its SHA-256
hash, writes an `invitation_created` security-audit record, and displays the
plaintext code exactly once. Capture that output in a trusted terminal or
secret-transfer tool; it cannot be recovered from PostgreSQL. Do not put a code
in shell arguments, environment variables, tickets, chat logs, or application
logs.

A new email supplies the code in the auth portal together with the magic-link
request. A valid request consumes one use and reserves that invitation for the
normalized email for 24 hours in `invitation_reservations`, which stores only
the SHA-256 digest of the address. The matching `security_audit` row
(`invitation_reserved`) references the invitation and reservation IDs, never the
email. Repeat magic-link requests for the same email during that window do not
consume another use; after the window a new request consumes one again. Email
delivery failure can therefore consume a use. Existing accounts do not need a
code, and `REGISTRATION_MODE=closed` rejects all new accounts. Setting
`revoked_at` stops new reservations, but an already issued 10-minute magic link
can remain valid; switch registration to `closed` when immediate containment is
required.

Account creation is gated in Better Auth's `user.create.before` hook for every
sign-up path, so a first-time GitHub sign-in on an `invite` installation is
rejected with `INVITATION_REQUIRED` (or `REGISTRATION_CLOSED`) and the browser
returns to the portal carrying that code. The portal reads `registration` from
`/.well-known/agentworld` and tells new operators to request the email link with
their invite code first; GitHub sign-in works once the account exists. Expired
reservation rows carry no personal data and may be purged as routine
maintenance.

## Hosted deployment (Render)

The reference Blueprint is `infra/render/render.yaml`. Import that explicit path
when creating the Blueprint. It provisions:

- one web API and one background worker from the same Dockerfile;
- private paid PostgreSQL 18 with storage autoscaling;
- private, nonpersistent Key Value for disposable state;
- API-generated auth, world-seed, and metrics bearer secrets, with runtime
  values shared through private environment references as needed;
- a migration pre-deploy command on both deployable processes, so a worker
  cannot start new code against an older schema. The database migration lock
  ensures concurrent deploy hooks still apply each migration once.

### First deployment

1. Review current Render pricing and plans; the Blueprint is an infrastructure
   baseline, not a public-internet security guarantee or spending guarantee.
   Set workspace budget notifications.
2. Create a production environment and import the Blueprint.
3. Enter the API's applicable `sync: false` OAuth and SMTP values.
4. Configure the GitHub OAuth application with the exact callback URL exposed
   by the auth implementation. Never use wildcard callbacks.
5. Confirm database and Key Value external IP allowlists are empty.
6. Sync and wait for the worker migration hook and API migrate-plus-seed hook,
   then for the API and worker to become healthy.
7. Confirm bootstrap created exactly one current world and that its private seed
   is absent from discovery, logs, and player-facing output.
8. Check `/health`, `/ready`, discovery metadata, a device login, email delivery,
   token revocation, and a read-only CLI profile.
9. Configure edge/DNS TLS, alerting, database backups/PITR, log retention, and
   the first restore rehearsal before opening registration.
10. Keep registration in `invite` mode, create short-lived single-use codes
    with the operator command above, and transfer each code through a secure
    channel. Use `closed` while investigating registration abuse.

The Blueprint derives `BASE_URL` from Render's external URL. Confirm it before
opening login; when adopting a custom domain, explicitly update/override the
value and all OAuth callbacks. A URL change invalidates assumptions in tokens,
cookies, redirects, and OAuth configuration.

### Normal release

1. Confirm the configured quality, integration, and container CI jobs pass on
   the exact commit. Automated OpenAPI/client drift and dedicated security
   scanning are not configured yet and are required before a public hosted
   beta.
2. Review dependency, schema, ruleset, auth, and environment changes. Confirm
   database capacity and worker compatibility for a rolling deploy.
3. Take/verify a recent backup or PITR point before a risky migration.
4. If the release cannot support the current schema both before and after
   migration, use an expand/migrate/contract release sequence instead.
5. Deploy the worker-compatible image and API through the Blueprint. Both
   pre-deploy hooks migrate, and the API hook also idempotently ensures a current
   season. The migration ledger serializes schema application.
6. Watch migration duration, readiness, structured error logs, database load,
   due-construction age, and ledger/resource deltas. Transaction-retry, pool,
   and general queue metrics are not emitted yet.
7. Exercise discovery, authentication, one read, and one idempotent development
   or operator-safe mutation in a staging world.
8. Record the image digest/Git commit, migration head, ruleset hashes, start/end
   time, operator, and outcome.

Application rollback is allowed only when the previous image supports the new
schema. Database rollback is not assumed. Prefer a corrective forward migration
or restore into a separate database for analysis; never improvise destructive
DDL on the live authority.

## Observability and alerting

Fastify/Pino JSON request logs go to stdout/stderr and include request IDs plus
an allowlisted method—never raw URLs, addresses, headers, or bodies. `/metrics`
exports bounded route-template/method/status-class HTTP series and Node runtime
series; production scrapes authenticate with `METRICS_TOKEN`. There is no
OpenTelemetry trace exporter or general job telemetry yet. Never log access/refresh tokens, cookies,
invite/device codes, authorization headers, message bodies, email/IP/device
data, or arbitrary player text.

Metric export must remain bounded so collector failure does not affect
gameplay. Labels use bounded values such as route
template, method, status class, stable result code, job kind, world lifecycle
state, and ruleset ID—not player IDs, raw URLs, coordinates, or text.

The following are post-instrumentation target alerts, not signals supplied by
the current application. Tune them after load tests:

| Signal | Warning | Critical/action |
|---|---|---|
| `/ready` | one failure during deploy | sustained 2 minutes: stop routing/investigate |
| HTTP 5xx | >1% for 5 min | >5% for 5 min: incident |
| Write p95 | >500 ms for 10 min | >1 s or rising timeouts |
| Read p95 | >250 ms for 10 min | >1 s or broad timeout |
| DB pool utilization | >70% for 10 min | >90%: prevent replica scale-out, inspect queries |
| Transaction retry/deadlock | above tested baseline | sustained/rising with failed writes |
| Oldest runnable job | >60 s | >5 min, or construction/season SLA breached |
| Failed/dead-letter jobs | any | repeated same cause or economic job |
| Resource ledger delta | unexpected rate/distribution | conservation violation: pause mutation |
| Disk/storage | >70% | >85% or autoscaling failure |
| Auth/ratelimit rejects | abnormal baseline deviation | coordinated attack or legitimate lockout |
| Season finalization | exceeds tested duration | cutoff blocked or partial ranking state |

Never page merely on a high player-visible rule-rejection rate without grouping
by stable code; normal play intentionally causes `409` responses.

## Incident response

These procedures define the beta operating standard. Independent per-action
kill switches and complete economic/job telemetry are not implemented yet;
until they are, containment may require stopping public API/worker processes or
changing edge access, and evidence is limited to HTTP/runtime metrics, available
logs, and database/provider state.

### General sequence

1. Declare severity, incident lead, start time, affected installation/worlds,
   and a private coordination channel.
2. Preserve evidence: deployment/image identifiers, migration/ruleset hashes,
   sanitized logs, available metrics, event offsets, security audit, and
   provider events.
3. Contain as narrowly as available. For uncertain economic integrity, stop
   public mutation traffic or the API; keep safe reads only if the edge can
   separate them reliably.
4. Do not delete scheduled structures, events, ledger entries, accounts, or
   suspicious state. Revoke credentials and isolate services instead.
5. Diagnose using read-only queries against a replica/snapshot where possible.
6. Repair through reviewed idempotent application/ledger operations or a tested
   migration. Record actor, reason, causal IDs, and before/after values.
7. Verify invariants and replay exact idempotency scenarios before resuming.
8. Notify affected users without exposing exploit details or personal data.
9. Write a blameless review with timeline, impact, root cause, controls, and
   assigned follow-ups. Follow `SECURITY.md` for coordinated disclosure.

Suggested severity:

- **SEV-1:** confirmed credential compromise, broad PII exposure, economic
  corruption, irreversible data loss, or total hosted outage.
- **SEV-2:** major action/auth outage, isolated exploitable integrity flaw,
  severely delayed season/jobs, or sustained partial unavailability.
- **SEV-3:** degraded performance, limited provider failure, or contained bug
  with no integrity/privacy loss.

### PostgreSQL unavailable or corrupt

1. Expect readiness to fail; prevent write traffic and stop workers from
   repeatedly reconnecting if they amplify load.
2. Check provider status, connections, storage, CPU/memory, slow/blocked queries,
   locks, and the most recent deploy/migration.
3. Do not route writes to a read replica or create a new empty primary.
4. For corruption/data loss, freeze the old authority and restore the newest
   valid PITR point into a **new** database.
5. Compare ledger/event/action offsets and committed receipts after the restore.
   Identify acknowledged actions beyond the restore point before switching.
6. Reconfigure only after invariant checks and a documented recovery decision.

### Backup and restore rehearsal

At least monthly and before a named beta season:

1. Select a PITR point or provider backup and restore to an isolated private
   database.
2. Use separate credentials and ensure no API/worker can send production email
   or accept public traffic from it.
3. Apply only the expected migration version; run schema, FK/check constraints,
   ledger-balance reconciliation, idempotency uniqueness, tile occupancy, open
   escrow, event offset, and season/ranking checks.
4. Record recovery point, restore duration, validation results, and deletion of
   the isolated copy under the data-retention policy.

A backup is not considered viable until a restore has passed these checks.

### Valkey unavailable

The configured API connects to Valkey during startup and checks it in readiness.
The limiter is configured not to fail open, so expect new traffic to fail if
the store becomes unavailable; PostgreSQL game authority remains intact.

1. Stop routing traffic to unready API replicas and confirm PostgreSQL health.
2. Inspect Valkey/provider status and API `rate-limit store error` logs.
3. Restore or replace the disposable instance without importing state.
4. Restart API replicas and confirm `/ready`, then verify a normal request and
   the `X-RateLimit-*` headers.

The current limit is coarse and keyed by network address. Per-account,
invite/device, and action-specific protections remain release work.

### Worker lag, crash loop, or poison job

The current worker handles due construction, trade expiry, and season
finalization directly from authoritative PostgreSQL rows. Generalized
retry/dead-letter metadata is not implemented, but one bad row or job kind
cannot wedge the others:

- Every poll runs construction completion, trade expiry, season finalization,
  and (after a finalization) next-season seeding inside separate failure
  boundaries. A job kind that throws is logged as `<job> failed for this poll`
  and the remaining kinds still run in the same poll. A failed seeding stays
  pending and is retried on the next poll.
- Construction completion and trade expiry process each due row in its own
  transaction. A row that fails is logged as `<job> skipped row <id>` together
  with the causal error, stays due, and is retried on a later poll while its
  neighbours still complete. Logs carry job kinds, row ids, and database error
  codes, never player-authored text.
- A poll with any failed job kind or skipped row counts as a failing poll. The
  poll interval (`WORKER_POLL_INTERVAL_MS`, default 1 s) doubles after each
  consecutive failing poll up to 60 s (`Worker poll had ... next poll in N ms`)
  and resets on the first clean poll. A persistent poison row therefore
  degrades the worker to one attempt per minute instead of a one-second crash
  loop; treat a steady stream of skipped-row lines as an incident.
- Worker-written events (`CONSTRUCTION_COMPLETED`, `RESOURCES_PRODUCED`,
  `SEASON_FINALIZED`) take their `aggregate_version` from the event journal
  (`max(aggregate_version) + 1` under the aggregate's row lock), the same
  allocator the API uses, so they cannot collide with API-written events under
  `events_emitter_aggregate_version_unique`.

1. Do not manually complete structures, resolve escrow, alter world state, or
   edit final rankings.
2. Inspect worker logs for `failed for this poll`, `skipped row`, and backoff
   lines, database locks, the oldest `constructing` `completes_at`, open trade
   `expires_at`, and due active/finalizing world `ends_at` values. A skipped
   row's id names the structure or trade to inspect.
3. Stop the worker while preserving structure rows, then fix and deploy the
   causal code or data through an audited procedure.
4. Restart one worker and verify each due item transitions once, ledgers/events
   agree with current state, player ranking counts match players, alliance
   ranking counts match eligible nonempty alliances, and a second pass makes
   no duplicate change (grouping `events` by `emitting_server_id,
   aggregate_type, aggregate_id, aggregate_version` yields no duplicates).
5. Scale only after checking PostgreSQL connection and lock headroom.

Season finalization still claims one world per transaction; a world that fails
to finalize is retried on every poll, with backoff, and blocks later due worlds
of the same installation until fixed. Email, maintenance, bounded retry, and
dead-letter procedures must be added when those durable job types are
implemented.

### Economic exploit or invariant violation

1. Disable the narrow action (`trade`, `combat`, production settlement, etc.);
   pause all mutations if the boundary is unknown.
2. Preserve action receipts, idempotency/request hashes, ledgers, events,
   scheduled structures/trades, relevant row versions, and
   deployment/ruleset identifiers.
3. Search by causal IDs and immutable offsets, not untrusted player text.
4. Reproduce against a restored snapshot with the original effective tick and
   ruleset hash.
5. Patch and add deterministic, property, and concurrency regression tests.
6. Repair only with balanced ledger entries referencing the incident and a
   restricted operator audit. Never `UPDATE inventory` alone.
7. Recompute/verify affected scores and disclose season remedies consistently.

### Credential or auth compromise

1. Revoke affected sessions/token families, OAuth credentials, invite batches,
   and operator credentials. Suspend affected accounts when necessary.
2. If `AUTH_SECRET` may be exposed, pause login/mutations, rotate it using the
   documented auth-library key-rotation compatibility procedure, and assume
   existing sessions need revocation. Do not blindly rotate into an incompatible
   single key while tokens are being accepted.
3. Rotate database, SMTP, telemetry, and deploy credentials independently based
   on exposure; update API and worker consistently.
4. Review restricted security audit and provider logs. Do not copy sensitive
   evidence into public events or tickets.
5. Notify affected users and issue a private advisory according to severity.

### Prompt/terminal injection report

1. Preserve the exact payload only in a restricted, deletable security record;
   use a hash/canary reference elsewhere.
2. Disable the affected renderer/channel if the sequence can execute or disguise
   commands. Do not paste the raw payload into terminals, chat, logs, or issues.
3. Test API structural taint, human CLI stripping/delimiting, JSON stdout, and
   browser escaping/CSP independently.
4. Search for output paths that bypass the canonical untrusted-text renderer.
5. Patch every affected client version and warn users before publishing the
   exploit string.

## Season operations

Implemented today: the cutoff check rejects mutations once `ends_at` passes; the
server enforces the 72-hour alliance-membership freeze; the worker finalizes one
due world per transaction (completing cutoff-eligible construction, settling
production through the final tick, expiring open trades and refunding escrow,
writing immutable player and alliance rankings, and archiving the world) and
then seeds the next season for the persisted installation id with a new
HMAC-derived seed. Not implemented yet: operator kill switches, per-action
pause, job and economy telemetry, and the representative load, multi-worker,
backup/restore, and failure-injection rehearsals that a hosted launch requires.

### Before a season

- Validate and hash the normalized ruleset; archive simulation/load-test output.
- Confirm start/end ticks, seed custody/publication policy, starter capacity,
  registration/invites, trust carryover, and alliance freeze time.
- Pass concurrency, economy, finalization, backup/restore, and dependency-loss
  rehearsals against the release candidate.
- Confirm operator kill switches and on-call access without development auth.
- Publish rules, schedule, reset semantics, maintenance window, and incident
  remedy policy to players.

### Finalization

1. Confirm the alliance freeze activated 72 hours before cutoff.
2. At cutoff, verify the world leaves `active`; do not allow new mutations.
3. Ensure one idempotent finalizer owns the transition and production settles
   through exactly the final tick.
4. Watch queue/locks and compare inventory/ledger creation, structure states,
   scores, ranking counts, ties, and event offsets.
5. Mark archived only after all invariants pass. Never open the next season to
   work around a stuck partial finalization.
6. Verify the worker created the next world using a new HMAC-derived persisted
   seed and pinned ruleset/generator hash. If recovery is required, run
   `pnpm season:create`; it is idempotent and advances only when no current
   scheduled/active/finalizing world exists. Verify only
   account/reputation/trust/history carried forward.
7. Publish final ranking identifiers and ruleset hash, then retain the archived
   read surface.

### Emergency ruleset change

Prefer a feature kill switch or new season. If a correctness/security issue
forces an in-season change:

1. Pause mutations and drain in-flight transactions/worker activity for
   affected actions.
2. Snapshot/backup and document reason, old/new normalized ruleset and hashes,
   effective tick, player impact, approval, and remediation.
3. Deploy code that explicitly supports the transition; write restricted
   operator audit and a public privacy-safe event/notice.
4. Run invariant and deterministic reproduction tests before resuming.

Never edit the stored ruleset row or YAML in place and continue silently.

## Capacity and scaling

The intended pre-public load gate is 500 concurrent sessions and 100 write
actions/second with p95 reads under 250 ms, p95 writes under 500 ms, bounded job
lag, and zero economic invariant failures. This gate has not yet been measured,
and the metrics needed to enforce it are not fully implemented.

Before increasing API/worker replicas:

- calculate total PostgreSQL connections across API, worker, migration, and
  operator pools with failure/redeploy overlap;
- test lock contention and transaction retries at the intended replica count;
- ensure every API replica has `REDIS_URL`, shares counters through Valkey, and
  no correctness relies on local memory;
- cap worker concurrency by database and job characteristics;
- load-test the exact production schema/indexes and representative world size.

Tune slow queries and indexes before adding replicas that amplify database load.
Do not introduce a queue service, read replica for consistency-sensitive reads,
partitioning, or regional authority until metrics demonstrate the need and the
architecture/threat model are revised.

## Maintenance and data handling

- Patch Node, PostgreSQL, Valkey, base images, dependencies, and GitHub Actions
  through reviewed automated changes and signed releases.
- Rotate service credentials on a documented cadence and immediately on
  exposure. Test session/key compatibility before auth-secret rotation.
- Retain immutable economic events according to game/audit policy. Keep
  security/operator audit restricted and time-bounded where law/policy permits.
- Delete or tombstone messages, reports, email, and PII through an audited
  operator procedure until dedicated jobs exist; verify backups follow provider
  expiry. Do not remove ledger/event integrity references when fulfilling
  deletion.
- Self-host upgrades follow release notes one version at a time when migrations
  say so. Back up and rehearse restore; never let the app auto-migrate on boot.

Record every production change and operator data access. If an operational
procedure repeatedly requires direct SQL, implement a scoped, authenticated,
idempotent operator command with dry-run output instead of normalizing manual
database edits.
