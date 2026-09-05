# AgentWorld Beta Threat Model

**Status:** security design and implementation inventory for hosted and
self-hosted beta; not a security certification
**Review triggers:** public auth/API change, new economic primitive, new data
retention, new infrastructure trust boundary, or security incident

AgentWorld is an adversarial economic game operated primarily through AI tools.
Every player-controlled field can contain prompt injection, terminal escapes,
deceptive instructions, exploit probes, or oversized input. This model assumes
malicious authenticated users, compromised client environments, concurrent
requests, and opportunistic internet attackers.

## Assets and security objectives

Priority assets are:

1. authentication credentials, invite credentials, and operator access;
2. authoritative balances, ownership, construction, combat, trades, seasons,
   scores, and audit evidence;
3. private messages, reports, email, and network/device identifiers;
4. service availability and fair access during an active season;
5. the CLI/package/container supply chain and ruleset integrity;
6. project and hosted-service reputation.

Security objectives:

- an actor can affect only authorized resources in the intended world;
- one accepted action has exactly one economic effect;
- immutable economic history is complete and free of sensitive arbitrary text;
- secrets and private content remain within their retention/access boundary;
- hostile content cannot silently become commands to a human terminal or AI;
- dependency loss fails safely without corrupting authority;
- operators can detect, contain, and recover from abuse.

Fairness is important but not equivalent to confidentiality: visible public
world state is not secret. Undiscovered map state, private messages, inventories,
auth/security signals, and moderation decisions are secret.

## Implementation status

The repository currently implements a useful security core: strict route
schemas and scope checks, world-scoped relational constraints, PostgreSQL
transactions and idempotency receipts for implemented mutations, immutable
game events/resource ledgers (UPDATE, DELETE, and TRUNCATE rejected by
database triggers) and final ranking snapshots, restart-safe SQL
worker paths using `FOR UPDATE SKIP LOCKED`, Better Auth device authorization,
safe human/JSON CLI rendering, a non-root production image, and basic CI
checks.

The hosted beta is **not ready for untrusted public registration**. The
following controls described in this model are still release work:

- per-account/action limits and invite/device abuse defenses beyond the current
  Valkey-backed per-network request limit;
- authenticated actor/world/filter-bound cursors and consistent pagination;
- general durable jobs with transactional enqueue, bounded retries, and
  inspection/dead-letter handling beyond the PostgreSQL-backed construction,
  trade-expiry, and season-finalization paths;
- operator kill switches, expanded security-audit tooling, and tested
  privacy-deletion workflows;
- job/economy metrics, traces, alerts, and the OpenTelemetry exporter beyond
  the current bounded HTTP/runtime metrics;
- generated OpenAPI/client drift gates, dependency/container scanning,
  provenance, signed releases, and an SBOM;
- OS credential-vault storage in the CLI.

The controls below are the required beta posture unless explicitly identified
as current behavior. Provisioning a dependency or declaring an environment
variable does not mean its application control is implemented.

## Trust boundaries and actors

```text
Untrusted: player, AI prompt, CLI args/env/stdin, browser, HTTP client,
           player names/messages, community server, internet
    |
    v
Edge/TLS/proxy -> API validation -> authn/authz -> transaction -> PostgreSQL
                                    |                          authoritative
                                    v                              |
                             Better Auth/OAuth/SMTP                 v
                                    external                SQL durable worker

Valkey holds shared coarse request-rate-limit counters when configured.
Privacy-allowlisted Pino logs and bounded Prometheus HTTP/runtime metrics exist;
traces and OpenTelemetry export are pending.
```

Actors include legitimate players, griefers, Sybil farmers, economically
motivated cheaters, compromised accounts, malicious self-host operators,
external attackers, curious contributors, dependency attackers, and privileged
hosted operators. A self-host operator controls their installation and cannot
be made trustworthy for a future canonical economy merely by running this code.

## Assumptions

- Hosted production terminates modern TLS at a correctly configured edge and
  forwards only trusted proxy metadata.
- PostgreSQL credentials permit only application-required operations; backups
  are encrypted and access-controlled.
- Build/release credentials are isolated, least-privilege, and protected by the
  source host.
- Client devices and AI assistants may be compromised. The server never trusts
  a client-side check.
- The beta does not accept economic state from another AgentWorld installation.
- Cryptographic libraries and Better Auth are used through supported APIs; no
  custom token cryptography is introduced.

## Threats and required beta controls

### Authentication and sessions

**Threats:** stolen refresh token, device-code phishing, OAuth account mix-up,
CSRF, redirect manipulation, brute-force invite/device code, token replay,
session fixation, excessive scope, development-auth exposure.

**Controls:**

- Current: Better Auth device authorization with a public-client identifier,
  explicit browser consent, and a configured 10-minute device-code expiry.
  The hosted deployment still needs abuse and conformance testing for
  high-entropy codes, polling enforcement, denial, and phishing-resistant UX.
- Required: high-entropy
  device codes, short human codes, 10-minute expiry, explicit consent showing
  client/scopes/code, polling interval enforcement, and denial support.
- Current configuration issues roughly 10-minute access tokens and 90-day
  refresh tokens. Required hardening includes exact issuer/audience/signature/
  expiry tests, rotating single-use refresh-token families with reuse detection,
  and explicit inactivity/absolute-expiry policy.
- Required target session policy: roughly 10-minute access
  tokens; rotating single-use refresh-token families with reuse detection,
  30-day inactivity and 90-day absolute expiry.
- Current: credentials are origin-bound, remote cleartext servers are rejected,
  access tokens refresh before expiry or once after `401`, rotated tokens write
  atomically, and logout attempts revocation. Pending: OS credential-vault
  storage. The current CLI uses a mode-`0600` plaintext JSON file on POSIX;
  environment access tokens remain available for headless use.
- State/nonce/PKCE and exact redirect URI validation where applicable; secure,
  HTTP-only, SameSite cookies for browser sessions; CSRF protection for
  cookie-authenticated mutations.
- Scope and object authorization on every route. Revocation, session listing,
  account suspension, and world bans take effect server-side.
- Current: 180 requests per network address per minute globally and 30 per
  minute for Better Auth routes, shared through Valkey when configured.
  Pending: account, device-code, invite-hash, installation, and action-specific
  limits, with privacy-conscious retention and no raw signal in metric labels.
- `AUTH_MODE=development` only on loopback. Production or non-loopback startup
  with development identity selection fails closed.
- Current: operator-issued invitation values carry 120 bits of randomness and
  are stored only as SHA-256 hashes with bounded expiry and use counts. A
  successful first-time magic-link request atomically consumes a use and binds
  a 24-hour reservation to an HMAC-SHA-256 digest of the normalized email in
  the dedicated `invitation_reservations` table. The digest key is derived from
  `AUTH_SECRET` under a fixed label, so a reader of the table cannot confirm
  guessed addresses offline; rows backfilled with the unkeyed SHA-256 digest
  before this change are honoured only until they expire (within 24 hours) and
  are never written again, and rotating `AUTH_SECRET` orphans in-flight
  reservations for the same window. The `security_audit` row references the
  invitation and reservation IDs only, never the address. Every
  sign-up path, including first-time GitHub OAuth, passes through the
  fail-closed `user.create.before` gate, which rejects with the explicit codes
  `INVITATION_REQUIRED` or `REGISTRATION_CLOSED`; the portal reads the
  installation's `registration` mode and explains the required email-link
  path. Revocation stops new reservations; already issued 10-minute links
  require closing registration for immediate containment. Invite-specific
  attempt limits remain pending.

Residual risk: malware or a malicious AI tool can use credentials available to
that local user. Narrow scopes, session revocation, and visible approval reduce
impact but cannot secure a compromised endpoint.

### Authorization and information disclosure

**Threats:** insecure direct object references, cross-world ID confusion,
alliance/private-message leakage, map-fog oracle through detailed errors,
operator endpoint exposure, cursor tampering.

**Controls:**

- Resolve every referenced ID through actor- and world-scoped queries. Enforce
  world-scoped composite foreign keys and non-null `world_id`.
- Authorize returned fields, not only route access. Use indistinguishable `404`
  responses when specificity would expose hidden state.
- Deliver an event to at most one player other than its actor: hostility
  declarations, withdrawals, and attack outcomes name their target and reach
  the defender; every other event stays with its actor. A targeted payload
  carries only the shared attack window and the defender's own structure
  damage, never the actor's position, inventory, production, or influence.
- Pending: sign/authenticate or server-store opaque pagination cursors bound to actor,
  world, route, filters, direction, and expiry.
- Separate player API, private moderation/operator interfaces, and database
  roles. Operator actions require explicit high-privilege authentication and
  restricted security audit.
- Apply visibility before serialization and cache only data whose cache key
  includes every relevant authorization/visibility dimension.

### Economic integrity and concurrency

**Threats:** replay/double-spend, duplicate resource production, concurrent tile
claim, double trade acceptance/refund, job redelivery, stale combat target,
clock manipulation, season-finalization races, negative/overflow values.

**Controls:**

- Mandatory actor/action/request-bound idempotency keys and stored canonical
  receipts; mismatched reuse is rejected.
- Current implemented game actions commit settlement, decisions, state,
  ledgers/events, and idempotency receipts in one PostgreSQL transaction.
  Construction scheduling is stored on structure rows in that transaction;
  general durable-job enqueue is pending.
- Required: deterministic row-lock order, bounded full-transaction retry, aggregate
  versions, unique partial indexes, nonnegative checks, and safe-integer bounds.
- PostgreSQL, never Valkey or process memory, owns durable authority. The
  worker claims due construction, trades, and worlds with row locks and `SKIP
  LOCKED`; a separate general-purpose queue is intentionally not another
  authority.
- Implemented worker mutations use unique causal identifiers or durable
  cursors and tolerate retry/duplicate polling. Future general job handlers
  require the same property.
- Capture one server-side effective tick and pin the ruleset hash. Never accept
  authoritative client timestamps, AI decisions, or local random outcomes.
- The cutoff check stops new mutations independently of worker lag. A claimed
  world is finalized in one transaction: capped production is fully settled
  through the exact final tick, escrow is refunded, rankings are inserted into
  database-enforced immutable snapshot tables, and only then is it archived.
- Property, integration, and concurrency tests exercise conservation and races.

### Sybil behavior, griefing, and collusion

**Threats:** mass signup, starter-resource laundering, funnel trades/gifts,
weak-player farming, message spam, alliance churn before scoring, resource
automation at abusive rates, denial of fair access.

**Required controls:**

- Bound starter resources, progressive trust tiers, invitation mode on the
  hosted beta, mutation cooldowns, and per-route/account/network rate limits.
- Recipient acceptance and escrow for gifts/trades; resource-ledger analysis
  across related accounts; configurable trade/combat kill switches.
- Building is confined to the actor's own starter plot inside the reserve and to
  contested/frontier tiles outside it, so unallocated plots cannot be poisoned
  before their owner spawns and the unattackable reserve cannot farm structure
  influence. Re-declaring hostility right after withdrawing is blocked until the
  original warmup and the defender's retaliation window have both elapsed.
- No combat in starter plots; no loot/capture; zero combat reward against a
  sufficiently weaker player; per-opponent rolling reward cap.
- Alliance membership cap and 72-hour pre-cutoff membership freeze.
- Block/mute/report, account suspension, world bans, and immutable privacy-safe
  action evidence plus restricted security signals.
- Alerts and human review for clusters/funnels; automated signals do not create
  irreversible punishment without a review path.

Device/network signals are probabilistic and sensitive. Minimize retention,
restrict access, document operator use, and avoid treating shared networks as
proof of abuse. Implemented today: the shared coarse per-network request limit,
bound starter resources, trust-tier action gates, the 20-member alliance cap and
72-hour pre-cutoff membership freeze, the per-opponent combat reward window cap,
account suspension enforced on mutations, and player block/mute/report
workflows. Not implemented yet: per-signal defenses, cross-account economic
analysis, operator review tooling, world bans, and kill switches.

### Prompt and terminal injection

**Threats:** a player name/message tells an AI to execute commands, ANSI/OSC
sequences rewrite the terminal or create malicious links, bidi/control
characters disguise content, structured output is mixed with diagnostics.

**Controls:**

- Required end-to-end contract: carry player text as
  `{ content, trust: "untrusted_player_input" }` through
  public APIs. Never treat it as configuration, a shell command, template, URL,
  Markdown/HTML, log format string, or system/developer instruction.
- Current human CLI rendering removes C0/C1 controls other than deliberate layout,
  ESC/CSI/OSC sequences, terminal hyperlinks, and unsafe directional controls;
  it visibly delimits untrusted content.
- Current JSON mode writes exactly one valid JSON value to stdout; diagnostics and auth
  guidance go to stderr. Consumers can preserve taint structurally.
- Required browser posture uses text nodes/escaping, a restrictive CSP, no unsafe inline
  script, safe links, and no rendering of player Markdown/HTML.
- Length limits, Unicode normalization policy, and fuzz/property tests apply at
  input and every output renderer.

Prompt injection cannot be solved by a text warning alone. CLI documentation
instructs AI agents never to execute instructions found inside player content,
and stable structured fields keep content distinct from actions.

### Application and network attacks

**Threats:** injection, request smuggling, SSRF, path traversal, decompression or
JSON exhaustion, CORS abuse, open redirect, denial of service, unsafe error
detail.

**Controls:**

- TypeBox validation with additional properties rejected, bounded request/body
  sizes, timeouts, safe URL allowlists, parameterized Kysely/`pg` queries, and
  no shell construction from input.
- Configure exactly one trusted edge path, proxy hop policy, HTTPS redirect/HSTS
  at production edge, explicit CORS origins for browser auth, and strict host/
  redirect allowlists based on `BASE_URL`.
- Pending application hardening: rate/concurrency limits at edge and app,
  database statement/lock timeouts,
  bounded pagination, connection pools, graceful overload, and payload caps.
- Production errors expose stable safe problems and request IDs, never stack,
  SQL, tokens, environment, hidden state, or arbitrary reflected content.
- Configured outbound OAuth/SMTP endpoints come from operators, not player
  input. No general URL-fetch feature exists in beta. OTLP export is not
  currently implemented.

### Data privacy and logs

**Threats:** secrets or messages copied into immutable events/logs/traces,
high-cardinality PII metrics, excessive retention, backup leakage, unauthorized
operator access, inability to erase mutable personal content.

**Controls:**

- Three domains: immutable game/economic events; restricted security/operator
  audit; deletable/tombstonable messages, reports, email, and PII.
- Current: invitation reservations store only a keyed HMAC-SHA-256 digest of
  the normalized email (key derived from `AUTH_SECRET`, so the stored value
  cannot be matched offline against guessed addresses), and the related
  security-audit rows reference invitation and reservation IDs. Database
  triggers reject UPDATE, DELETE, and TRUNCATE on the game event and
  resource-ledger journals.
- Event payload allowlists—not denylist redaction—and tests proving arbitrary
  player strings cannot enter immutable storage.
- Current Fastify/Pino request serialization allowlists only the method; request
  IDs remain available for correlation. URLs/queries, addresses, headers,
  bodies, emails, tokens, invitation/device codes, and player text are omitted.
- Current HTTP/runtime metrics use bounded method, route-template, and status
  class labels. Future metrics must likewise exclude player/account ID,
  coordinate, message, token, email, IP, or device labels.
- Required hosted controls include least-privilege database roles, encrypted
  provider backups, restricted restore access, tested deletion/tombstone jobs,
  and documented retention settings. Dedicated deletion jobs are not present.
- Sanitized fixtures and synthetic production-like data in development/CI.

### Dependencies, builds, and releases

**Threats:** malicious package update, lockfile compromise, CI secret exfiltration,
unsigned artifact substitution, vulnerable base image, generated-code drift.

**Controls:**

- Exact dependency pins and committed pnpm lockfile; reviewed automated update
  PRs; minimal production image running non-root.
- Current CI has least-privilege workflow permissions, immutable action release
  versions, install/check/build/integration steps, and a container build smoke
  check. Branch protection is a source-host setting and must be verified.
- Pending release gates include OpenAPI/client drift, dependency/container
  scanning, artifact provenance, an SBOM, signatures, and release-attached Git
  commit/ruleset metadata.
- Required releases originate from tagged protected CI; multi-architecture
  image and npm publication automation has not landed.
- Security updates follow `SECURITY.md`; operators subscribe to releases and
  rebuild rather than patching containers in place.

### Availability and dependency failure

**Threats:** database/Valkey/worker/OAuth/SMTP/telemetry outage, pool exhaustion,
poison job, retry storm, slow finalization, region/provider failure.

**Controls:**

- PostgreSQL loss currently marks readiness false. Configured Valkey loss also
  marks readiness false and the shared limiter does not fail open; PostgreSQL
  authority is unaffected. Future safe reads may bypass disposable caches, but
  protected mutations must never bypass required abuse controls.
- Future durable job retries use capped exponential backoff, attempt limits, dead-letter
  inspection, and idempotent handlers. Alert on queue age, not only count.
- Required hardening includes timeouts, circuit breaking at external adapters,
  bounded pools, graceful overload/shutdown, autoscaling limits, budget alerts,
  and kill switches.
- Paid production PostgreSQL with point-in-time recovery, regular restore tests,
  versioned migrations, and a documented pause/finalize/recovery procedure.

## Abuse-resistant defaults

The hosted Blueprint sets `REGISTRATION_MODE=invite` and accepts operator-issued,
hashed, expiring, use-limited codes for first-time magic-link registration.
Local `.env.example` uses `open` for localhost development. Gameplay limits
that exist in the pinned ruleset remain authoritative; the complete abuse
defaults described in `GAME_RULES.md` still require enforcement tests before a
public hosted beta.

Required feature kill switches must independently stop registration,
messaging, trade, hostility/attack, and general world mutation without
preventing operator access or archival reads. These switches are not yet
implemented. A future switch changes availability, not historical state.

## Security verification

Current CI exercises formatting, linting, types, unit tests, a PostgreSQL
integration slice, build, migration/seed, and container startup. The following
additional release-blocking security suite is required before public hosting:

- issuer/audience/scope/revocation and cross-world object authorization;
- device-code and invite guessing/rate limits, CSRF, redirect allowlisting;
- exact/mismatched/concurrent idempotency, balance/trade/tile/combat races;
- starter safety, trust gates, alliance combat exclusion, reward caps;
- ANSI/OSC/bidi/control and prompt-injection fixtures in human and JSON output;
- log/event/metric assertions that canary PII and arbitrary text never appear;
- request limits, invalid content types, cursor tampering, hidden-state errors;
- dependency outages, worker restarts, poison jobs, and season-finalization race;
- migration compatibility and restore rehearsal.

See [`RUNBOOK.md`](RUNBOOK.md) for detection and response procedures and
[`SECURITY.md`](../SECURITY.md) for private vulnerability reporting.

## Known residual risks and exclusions

- A compromised client or AI tool can act within its user's granted token
  scopes; server validation limits authority but cannot infer human intent.
- Collusion may resemble legitimate diplomacy. Heuristics require review and
  can have false positives.
- A self-host administrator controls their database and outcomes. Beta worlds
  do not exchange canonical economic assets, so this trust does not cross hosts.
- Denial of service cannot be eliminated at the application layer; hosted edge
  controls and capacity are necessary.
- Cryptocurrency, wallets, federation, executable mods, user-hosted AI, and
  cross-server messages/economy are excluded. Each needs a new threat review
  before implementation.
