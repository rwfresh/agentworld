# Instructions for AI Coding Agents

This file governs the entire repository. A more specific `AGENTS.md` may add
constraints within a subtree, but it may not relax these safety, architecture,
or verification requirements.

## Source of truth

Read the relevant source before editing:

1. `docs/AgentWorld_PRD_v1.md` defines product intent.
2. `docs/GAME_RULES.md` defines beta game behavior and balance defaults.
3. `docs/ARCHITECTURE.md` defines dependency direction and transaction flow.
4. `docs/API.md` defines public HTTP and CLI behavior.
5. Existing tests and code define implemented compatibility constraints.

When these conflict, do not silently choose one. Preserve shipped behavior and
update the documents in the same change, or call out the conflict for a human
decision.

## Architecture boundaries

- Put authoritative game decisions in `packages/game-rules`. The package must
  be deterministic and side-effect free: no HTTP, database, filesystem,
  environment, timers, randomness, logging, or framework dependencies.
- Route handlers validate transport input, authenticate, authorize, and call an
  application service. They must not calculate costs, damage, production,
  cooldowns, visibility, scores, or other game rules.
- CLI code is an API client. It must not reimplement rules or infer hidden
  server state.
- `packages/api-contract` owns public wire schemas. Derive types from schemas;
  do not maintain parallel handwritten request/response shapes.
- `packages/db` owns migrations, the current handwritten database types, and
  database utilities.
  Do not expose query-builder or driver objects to the rules package.
- `apps/server` composes dependencies manually at entrypoints. Prefer small
  interfaces owned by their consumer over a dependency injection container,
  base repository classes, or service locators.
- Keep types with the subsystem that owns their meaning. Do not create a
  generic dumping-ground `shared`, `common`, `utils`, or `types` package.
- PostgreSQL is authoritative. Valkey may hold rate limits, presence, and
  caches only. Never require process-local state for correctness.
- Events are an immutable audit/feed journal, not an event-sourced rebuild
  mechanism. Current relational state remains authoritative.

Allowed dependency direction:

```text
apps/cli ---------> api-client ---------> api-contract
apps/auth-web ----> api-client ---------> api-contract
apps/server ------> api-contract
apps/server ------> game-rules
apps/server ------> db
db --------------> game-rules domain identifiers only when unavoidable
```

`game-rules` must never import from an app, database, API, or auth package.

## Correctness requirements

- Pass an explicit effective tick and ruleset into domain decisions. Never read
  `Date.now()` or generate random values inside authoritative rules.
- Use integer arithmetic for resources, coordinates, ticks, damage, and score.
  Reject unsafe JSON integers and enforce database bounds.
- Every world-owned row carries a non-null `world_id` and uses world-scoped
  foreign keys. Keep `world.home_server_id`, `region.authority_server_id`, and
  `event.emitting_server_id` semantically distinct.
- Every mutation requires an idempotency key bound to the authenticated actor,
  route/action kind, and canonical request hash. A replay returns the stored
  response; a reused key with a different request is a conflict.
- Settle lazy production, decide the action, update state and ledgers, append
  events, store the idempotent response, and persist any resulting durable work
  in one PostgreSQL transaction. Current construction work is represented by
  structure rows; future queue enqueue must retain this atomic boundary.
- Lock rows in deterministic identifier order. Enforce nonnegative balances,
  uniqueness, and occupancy with database constraints as well as application
  checks.
- Background jobs and retryable transactions must be idempotent.
- Never change the ruleset of an active world silently. Persist normalized
  ruleset data and its hash with the world and action/event context.

## Security and privacy

- Treat all CLI and player input as hostile. Validate at the wire boundary and
  authorize every referenced object within its world.
- Player-authored text remains explicitly untrusted through storage and output.
  Strip terminal control sequences from human CLI output and keep stable JSON
  output free of diagnostics.
- Never place message bodies, email addresses, tokens, invite codes, IP/device
  signals, or arbitrary player text in immutable events, logs, exception
  messages, or metric labels.
- Do not commit secrets. Update `.env.example` with safe placeholders whenever
  adding required configuration.
- Do not weaken protected starter plots, bound starter resources, rate limits,
  scopes, or moderation controls without updating the threat model and tests.
- See `SECURITY.md` for reporting and `docs/THREAT_MODEL.md` for controls.

## Code style

- Use strict TypeScript and ESM. Avoid `any`; use `unknown` plus validation at
  trust boundaries.
- Prefer narrow modules, pure functions, discriminated unions, and explicit
  return types on public APIs.
- Validate configuration once at startup and inject typed configuration.
- Avoid speculative abstraction. Extract shared behavior only when there are
  multiple real consumers or a domain concept needs a named boundary.
- Comments explain intent, invariants, or a non-obvious tradeoff; they do not
  narrate syntax.
- Use structured errors with stable machine codes. Do not branch on error text.
- Keep dependencies exact-pinned and justify new production dependencies in
  the pull request.

## Database migrations

- Migrations are append-only after merge. Never edit, reorder, or delete an
  applied migration.
- Migration names use an ordered timestamp/sequence and a concise description.
- Separate risky data backfills from schema changes. Make deploy-order and
  rollback implications explicit in the pull request.
- Production processes never auto-migrate on boot. Deployment runs migrations
  as a distinct pre-deploy/release step.
- Destructive or table-rewriting changes require a tested expand/migrate/
  contract strategy. Do not assume beta data may be discarded once a named
  season begins.
- Update and review the handwritten database interface when the schema changes.
  If generation is introduced, regenerate and commit the artifact.

## Tests and required checks

Every game action needs tests for success, rule rejection, authorization,
idempotent replay, and economic invariants. Add concurrency integration tests
when a change can race on balances, tiles, combat, trades, jobs, or seasons.

Before handing off a change, run the smallest relevant tests and then:

```console
pnpm check
pnpm build
```

For database, auth, queue, or end-to-end changes also run:

```console
docker compose up -d postgres valkey mailpit
pnpm test:integration
```

If a command is unavailable or cannot run, report that fact and the reason; do
not claim success. Never update snapshots simply to silence a failure.

## Change discipline

- Preserve unrelated working-tree changes. Do not rewrite files owned by
  another task without coordinating.
- Keep the current handwritten API client/database interface synchronized with
  canonical schemas. When generated artifacts and drift checks land, update
  and run them in the same change.
- Update docs and `.env.example` in the same change as a public command, API,
  rule, operational procedure, or configuration change.
- Add a Changeset for publishable package behavior. Internal docs, tests, and
  CI-only changes do not require one.
- Do not introduce federation, blockchain, wallets, microservices, Kubernetes,
  a general game web UI, server-side AI decision making, or executable plugins
  in beta unless the product scope is explicitly revised.
