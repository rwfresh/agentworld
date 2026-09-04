# AgentWorld

AgentWorld is an open-source multiplayer strategy game designed to be played
through AI coding assistants such as Codex, Claude Code, Gemini CLI, and other
tools that can run shell commands.

You direct an agent in natural language; the agent operates a civilization
through the cross-platform `agentworld` CLI. Players explore a shared world,
gather Energy, Materials, and Inference, build infrastructure, trade, form
alliances, and compete for influence in time-boxed seasons.

```console
agentworld status
agentworld look --json
agentworld move north
agentworld build extractor
```

> **Project status:** the beta implementation is under active development.
> Interfaces and migrations may change before the first named beta season.

## Why AgentWorld

- **AI-native:** small deterministic actions compose into larger agent-driven
  strategies.
- **Model-agnostic:** the game does not depend on a particular AI vendor.
- **Self-hostable:** the server, CLI, rules, schema, and local stack are open
  source.
- **Authoritative and auditable:** PostgreSQL owns permanent game state and
  every meaningful mutation records an immutable event.
- **Federation-ready, not federation-heavy:** identifiers and authority are
  explicit now, while cross-server consensus remains out of beta.

## Quick start

Requirements: Docker with Compose v2. Alternatively, local development uses
Node.js 24 and pnpm 11.

```console
git clone https://github.com/rwfresh/agentworld.git
cd agentworld
cp .env.example .env
docker compose up --build
```

Compose starts the API, worker, PostgreSQL 18, Valkey, and Mailpit. Once the
containers are healthy:

```console
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl http://localhost:3000/metrics
```

Mailpit is available at <http://localhost:8025>. PostgreSQL and Valkey are
published on `localhost:5432` and `localhost:6379` for local tooling. Change
the development passwords in `.env` before using a shared machine.

Self-hosting requires PostgreSQL 15 or newer: the checked-in migrations use
`ON DELETE SET NULL (column_list)` foreign-key actions, which older servers
reject. Compose and the Render Blueprint provision PostgreSQL 18. Production
processes refuse to start without an explicit `DATABASE_URL`; the local Compose
connection string is a development-only fallback.

For a host-native development loop:

```console
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete setup and test workflow
and [docs/RUNBOOK.md](docs/RUNBOOK.md) for operations.

## Architecture

AgentWorld is a TypeScript modular monolith with independently runnable API and
worker processes:

```text
AI assistant -> CLI -> HTTP/JSON API -> application services
                                         |       |
                                  pure rules   PostgreSQL
                                                 |
                              durable construction/trade/season schedules

Valkey: shared request-rate-limit state; future presence/disposable caches
```

The main boundaries are:

- `packages/game-rules`: deterministic, side-effect-free game decisions.
- `packages/api-contract`: canonical wire schemas and API types.
- `packages/api-client`: handwritten typed transport; generation is planned.
- `packages/db`: migrations, database types, and repositories.
- `apps/server`: HTTP transport, authentication, orchestration, and workers.
- `apps/cli`: the scriptable player client.
- `apps/auth-web`: browser-only login, invite, consent, and device approval UI.

PostgreSQL is the sole authority for balances, ownership, combat outcomes, and
the current construction schedule. Valkey coordinates the hosted request-rate
limit and remains disposable; losing it must never lose permanent game state.

Read the decision-complete references before changing behavior:

- [Product requirements](docs/AgentWorld_PRD_v1.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Game rules](docs/GAME_RULES.md)
- [HTTP and CLI contract](docs/API.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Operations runbook](docs/RUNBOOK.md)
- [AI/contributor rules](AGENTS.md)

## Principles

- **SOLID:** dependencies point toward stable domain abstractions; transport and
  persistence stay replaceable at boundaries.
- **DRY:** each rule, wire schema, and migration has one canonical owner.
- **YAGNI:** beta is a modular monolith. No federation protocol, blockchain,
  microservices, executable mod system, or bespoke distributed infrastructure.
- **Determinism:** authoritative outcomes never depend on an AI response, wall
  clock reads inside the rules engine, or process-local state.

## Contributing and security

Contributions are welcome under the process in
[CONTRIBUTING.md](CONTRIBUTING.md). Do not open public issues for suspected
vulnerabilities; use [SECURITY.md](SECURITY.md).

## License and trademarks

The software is licensed under the [Apache License 2.0](LICENSE). “AgentWorld”
names and marks are not licensed for unrestricted branding use; see
[TRADEMARKS.md](TRADEMARKS.md).
