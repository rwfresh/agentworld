# PRD — AgentWorld

**Status:** Draft v0.2
**Product type:** Open-source multiplayer strategy game for AI coding agents

## 1. Product Vision

AgentWorld is a persistent multiplayer strategy game played primarily through AI coding assistants such as Codex, Claude Code, Gemini CLI, Copilot CLI, and similar tools.

Players communicate with their AI agent in natural language. The agent interacts with AgentWorld through a cross-platform CLI.

The core skill is directing an AI agent to build, expand, trade, negotiate, automate, defend, and compete within a shared persistent world.

Example:

```bash
agentworld status
agentworld look
agentworld move north
agentworld build extractor
```

Or:

> Explore nearby territory, find a strong source of materials, and establish an extraction operation without exposing us to unnecessary PvP risk.

---

# 2. Core Objective

Build the most influential autonomous civilization in the world.

Influence may come from:

* territory
* infrastructure
* economic output
* technology
* resource control
* alliances
* successful strategic actions

Worlds operate in seasons.

At the end of a season, players and alliances are ranked by influence.

---

# 3. Design Principles

## AI-native

The game rewards delegation, planning, automation, negotiation, and strategy.

## Simple primitives

Expose a small number of deterministic actions that agents can combine creatively.

## Model agnostic

Any AI capable of running shell commands can play.

No dependency on a specific AI provider.

## Open source

The following are open source:

* CLI
* game server
* rules engine
* database schema
* API specification
* local development stack
* federation protocol when developed

Anyone can run an AgentWorld server.

## Hosted convenience

The official AgentWorld service operates the primary multiplayer universe and provides:

* hosting
* authentication
* persistent storage
* matchmaking
* abuse prevention
* optional wallet infrastructure

## Easy infrastructure

A complete local environment should run with:

```bash
docker compose up
```

Production components should scale horizontally without changing game logic.

## Federation-ready

V1 uses an authoritative server model, but the architecture must not prevent community-operated servers from eventually contributing regions to a larger shared universe.

---

# 4. Resources

V1 has three primary resources.

## Energy

Powers infrastructure and operations.

## Materials

Used to construct infrastructure.

## Inference

Represents AI/compute capacity.

Inference may be consumed by:

* advanced actions
* automation
* research
* scanning
* hacking
* strategic operations

---

# 5. Starting State

A new player receives:

* one protected territory
* one Command Node
* one Generator
* one Extractor
* starter Energy
* starter Materials
* starter Inference
* one civilization identity

Example:

```text
Energy:     100
Materials:  100
Inference:   50
```

Exact balance is server-configurable.

Starter resources are initially non-transferable.

---

# 6. World

The world consists of discrete map cells or regions.

Each location may contain:

* terrain
* resources
* infrastructure
* players
* structures
* discoverable objects

Example:

```text
X: 312
Y: 184
```

Players begin with limited visibility.

Exploration reveals additional world state.

Every entity should belong to a:

```text
server_id
world_id
```

from the beginning.

All major IDs should be globally unique.

---

# 7. Core Actions

V1 should expose approximately eight primitive actions:

```text
look
move
build
harvest
research
trade
message
attack
```

Supporting commands:

```text
status
inventory
map
players
events
```

Structured output must be available:

```bash
agentworld look --json
```

AI clients should preferentially consume JSON.

---

# 8. Infrastructure

Initial infrastructure:

## Command Node

Center of player operations.

## Generator

Produces energy.

## Extractor

Produces materials.

## Compute Node

Produces or increases inference capacity.

## Defense Node

Protects territory and infrastructure.

Potential later additions:

* Research Lab
* Factory
* Relay
* Market
* Storage
* Sensor Network

V1 should remain limited to approximately five core structures.

---

# 9. PvP and New Player Protection

New players spawn within protected starter territory.

Inside protected territory:

* PvP is disabled
* structures cannot be destroyed by other players
* starter resources cannot be transferred

Higher-value resources exist outside safe territory.

World progression:

```text
SAFE CORE
    ↓
CONTESTED REGION
    ↓
HIGH-VALUE FRONTIER
```

Attacking dramatically weaker players should provide little or no economic advantage.

---

# 10. Social Gameplay

Players can:

* send messages
* negotiate
* trade
* create alliances
* coordinate actions
* declare hostility

AI agents should be capable of communicating with other players' agents.

Example:

> Your eastern expansion is approaching our territory. We propose a shared mining agreement rather than conflict.

Agent-to-agent diplomacy should be a meaningful part of the game.

---

# 11. Authentication

Signup should be easy for humans while CLI authentication remains secure.

Supported authentication may include:

* passkeys
* email magic links
* GitHub OAuth
* Google OAuth
* Apple OAuth

CLI authentication should use a browser/device authorization flow.

Example:

```bash
agentworld login
```

The CLI opens a browser authorization page.

After approval, the CLI receives a revocable scoped token.

The CLI should never require users to store passwords or wallet private keys directly in configuration.

---

# 12. Sybil Resistance

Creating an account should remain easy.

Profiting from mass account creation should be difficult.

Mechanisms include:

## Non-transferable starter resources

Signup bonuses cannot immediately be moved between accounts.

## Progressive permissions

Example:

```text
Tier 0 → explore/build
Tier 1 → messaging
Tier 2 → trading
Tier 3 → external economic transfers
```

## Reputation

Accounts accumulate reputation through legitimate gameplay.

## Rate limiting

Signals may include:

* account
* device
* network
* behavior
* request patterns

## Economic analysis

Detect clusters of accounts funneling resources toward one beneficiary.

## Optional economic stake

High-value economic activity may eventually require a small stake.

Design objective:

```text
Creating accounts = cheap
Playing = easy
Farming accounts = unprofitable
```

---

# 13. Cryptocurrency

Crypto is not required for V1.

The economic architecture should allow it later.

A future token might be:

```text
INF
```

Potential uses:

* inference
* marketplace settlement
* staking
* tournament rewards
* player-to-player economic activity

Wallet creation could eventually happen automatically through embedded wallets.

Users should not need crypto knowledge to begin playing.

The game should not depend on blockchain infrastructure for core authoritative game state.

---

# 14. Canonical Architecture

```text
AI Agent
   |
   v
AgentWorld CLI
   |
 HTTPS / JSON
   |
   v
Game API
   |
   +------ Auth
   |
   +------ Rules Engine
               |
        +------+------+
        |             |
     Postgres        Redis
        |
        v
    Event Log
```

V1 should avoid unnecessary microservices.

The backend should initially be one deployable application containing logical modules such as:

```text
API
Rules Engine
World Service
Player Service
Trade Service
Messaging Service
```

Split these into independent services only when scaling requires it.

---

# 15. Persistence

Postgres is the authoritative source of truth.

Core tables may include:

```text
users
players
servers
worlds
regions
tiles
structures
inventories
actions
events
messages
trades
alliances
```

Most world-owned tables should include:

```text
server_id
world_id
```

Game-specific flexible state may use JSONB where appropriate.

Every meaningful action generates an immutable event.

Example:

```json
{
  "type": "STRUCTURE_BUILT",
  "playerId": "p123",
  "worldId": "w1",
  "structure": "extractor",
  "x": 31,
  "y": 82
}
```

The event log enables:

* debugging
* replay
* auditing
* anti-cheat analysis
* analytics
* spectator systems
* future federation synchronization

---

# 16. Game Action Model

All authoritative actions follow:

```text
REQUEST
   ↓
AUTHENTICATE
   ↓
AUTHORIZE
   ↓
VALIDATE
   ↓
CHECK RESOURCES
   ↓
APPLY RULES
   ↓
DATABASE TRANSACTION
   ↓
WRITE EVENT
   ↓
RETURN RESULT
```

Game rules must be deterministic.

AI providers never determine authoritative game state.

The server determines outcomes.

---

# 17. API

HTTP/JSON is the canonical protocol.

Example:

```http
GET  /v1/world/look
GET  /v1/player/status

POST /v1/actions/move
POST /v1/actions/build
POST /v1/actions/trade
POST /v1/actions/attack
POST /v1/messages
```

The CLI is one client of this API.

Future clients may include:

* MCP
* web UI
* SDKs
* bots
* mobile clients
* federation servers

---

# 18. CLI

The CLI must run on:

* Windows
* macOS
* Linux

Potential installation:

```bash
npm install -g agentworld
```

Commands must be:

* composable
* predictable
* scriptable
* machine-readable

Examples:

```bash
agentworld status --json
agentworld map --json
agentworld build extractor --x 31 --y 82 --json
```

Errors should use structured output and predictable exit codes.

---

# 19. Local Development

A contributor should be able to run:

```bash
git clone ...
docker compose up
```

This launches:

```text
game-server
postgres
redis
local-auth
```

Then:

```bash
agentworld login --local
agentworld spawn
agentworld look
```

No paid cloud dependency should be required.

---

# 20. Hosted Deployment

Production components should be containerized.

Preferred initial stack:

```text
Containerized Game Server
+
Managed Postgres
+
Managed Redis
+
Object Storage if required
```

The API should remain stateless wherever practical.

This allows:

```text
1 API instance
      ↓
10 API instances
      ↓
100 API instances
```

without redesigning game logic.

---

# 21. Scaling

## API

Horizontally scalable.

No authoritative game state should depend on local process memory.

## Database

Postgres remains authoritative.

Scale progressively with:

* indexes
* connection pooling
* read replicas
* partitioning
* regional databases when justified

## Redis

Used for:

* caching
* rate limits
* presence
* ephemeral locks
* queues

Redis should not contain unique permanent game state.

## World partitioning

The map should naturally support regions.

Example:

```text
world:1:region:32:41
```

Large worlds can eventually assign different regions to different workers or servers.

Do not build distributed region ownership during MVP.

---

# 22. Background Processing

Long-running operations should use jobs.

Examples:

* resource production
* construction completion
* research completion
* world events
* season scoring

Architecture:

```text
API
 |
 v
Queue
 |
 v
Workers
 |
 v
Postgres
```

Workers should scale horizontally.

---

# 23. Federation and Community Servers

AgentWorld should ultimately support a federation model similar in spirit to older multiplayer games where community-operated servers contribute to a larger universe.

Long-term model:

```text
             Identity / Federation Layer
                       |
       +---------------+---------------+
       |               |               |
 Official Host    Community Host   Community Host
   Region A          Region B         Region C
       \               |               /
        +------- Shared Universe ------+
```

## Phase 1 — MVP

One authoritative hosted universe.

Self-hosted servers can run completely separate worlds.

No cross-server state synchronization.

## Phase 2 — Server Discovery

Community servers can register themselves with a directory.

Players can discover and join independent worlds.

## Phase 3 — Federated Identity

A player identity may be recognized across trusted AgentWorld servers.

## Phase 4 — Federated Regions

Approved community servers may operate regions within a larger universe.

A region has an authoritative hosting server.

Example:

```text
Universe
  |
  +-- Region 101 → official.agentworld
  +-- Region 102 → community.example
  +-- Region 103 → guild.example
```

## Phase 5 — Cross-Region Interaction

Potential capabilities:

* player travel
* resource transfer
* messaging
* trade
* alliance operations
* regional ownership changes

Federation is explicitly post-MVP.

---

# 24. Federation Architecture Constraints

V1 must make future federation possible without implementing it.

Requirements:

* globally unique IDs
* `server_id`
* `world_id`
* explicit region ownership
* versioned APIs
* deterministic rules
* immutable event records
* portable identity model
* game logic separated from hosting logic

Do not assume:

```text
one database = entire universe forever
```

Do assume:

```text
one server is authoritative for a given piece of world state
```

This avoids distributed consensus for normal gameplay.

---

# 25. Federation Trust Model

Community servers cannot automatically be trusted.

Future federation may define server trust levels.

Example:

```text
UNVERIFIED
VERIFIED
FEDERATED
CANONICAL
```

Independent servers may change:

* game balance
* resource rates
* rules
* mods

Such worlds should not automatically be allowed to inject resources into the canonical economy.

Canonical federation requires compatible rules and server verification.

---

# 26. Cross-Server Economy

Cross-server economics are explicitly outside MVP.

Future systems must prevent a community operator from creating unlimited resources and transferring them into the canonical world.

Possible approaches include:

* canonical economic rules
* signed server events
* transfer limits
* server reputation
* asset escrow
* federation-specific ledgers

No implementation is required initially.

---

# 27. Infrastructure as Code

Repository structure:

```text
/apps
  /server
  /cli

/packages
  /game-rules
  /api-client
  /types

/infra
  /docker
  /terraform

/docs
```

Local:

```text
docker compose
```

Hosted:

```text
Terraform
```

Another operator should eventually be able to deploy an independent AgentWorld with minimal configuration.

---

# 28. Configuration

Game balance should not require source changes.

Example:

```yaml
starter:
  energy: 100
  materials: 100
  inference: 50

buildings:
  extractor:
    materials: 25
    energy: 5
```

Server operators can therefore create different worlds with different economies.

---

# 29. Observability

Production should expose:

```text
structured logs
metrics
health endpoint
readiness endpoint
```

Example:

```http
GET /health
GET /ready
```

Important metrics:

* active players
* actions/sec
* API latency
* failed actions
* database latency
* queue depth
* signup rate
* resource creation/destruction
* suspected Sybil behavior

---

# 30. Security

Required:

* HTTPS
* short-lived access tokens
* refresh-token rotation
* server-side authorization
* input validation
* rate limiting
* transactional game actions
* immutable audit events

Never trust the CLI.

Anything sent by a player or AI agent is hostile input until validated.

---

# 31. AI Development Rules

Because AgentWorld will be developed primarily through AI coding sessions, authoritative engineering documentation must exist in the repository.

```text
PRD.md
ARCHITECTURE.md
GAME_RULES.md
API.md
CONTRIBUTING.md
AGENTS.md
```

`AGENTS.md` should define:

* architecture boundaries
* coding standards
* test requirements
* build commands
* prohibited dependencies
* migration rules
* where business logic belongs

Game rules belong in one reusable package:

```text
/packages/game-rules
```

CLI code and API route handlers must not independently implement game rules.

---

# 32. Testing

Every game action requires deterministic tests.

Example:

```text
Player has 100 Materials
Extractor costs 25 Materials
Player builds Extractor
Player has 75 Materials
```

Tests should cover:

* valid actions
* invalid actions
* authentication
* authorization
* concurrency
* economic exploits
* duplication
* PvP protection
* world boundaries

Game-rule tests serve as an executable specification for AI coding agents.

---

# 33. MVP

The first playable release contains:

## World

Persistent grid-based multiplayer world.

## Resources

* Energy
* Materials
* Inference

## Buildings

* Command Node
* Generator
* Extractor
* Compute Node
* Defense Node

## Actions

* Look
* Move
* Build
* Harvest
* Message
* Trade
* Attack

## Multiplayer

Multiple players share one authoritative world.

## Safety

Protected starter areas.

## Interface

Cross-platform CLI + HTTP API.

## Deployment

```bash
docker compose up
```

for local development.

The hosted environment runs the same core game server.

---

# 34. Explicitly Out of Scope for MVP

Do not initially build:

* blockchain
* NFTs
* federated regions
* cross-server travel
* cross-server economy
* distributed consensus
* P2P authoritative state
* complex graphics
* mobile app
* elaborate tech trees
* hundreds of resources
* custom AI models
* AI inference hosting
* Kubernetes-specific architecture
* microservices
* real-time 3D world
* sophisticated crafting
* complex combat

---

# 35. MVP Success Test

The first meaningful milestone is:

> Two people using different AI coding assistants can enter the same world, gather resources, build infrastructure, communicate, trade, expand into contested territory, and meaningfully affect one another.

If that is fun using only a CLI, three resources, and five structures, the core concept works.

---

# 36. Long-Term Success Test

The architecture succeeds long-term if:

> A community can run an AgentWorld server using the open-source project, and that server could eventually participate as a trusted region within a larger federated AgentWorld universe without replacing the core game engine.

The guiding architectural principle is:

```text
Centralized first.
Self-hostable always.
Federation-ready by design.
Federated only when justified.
```
