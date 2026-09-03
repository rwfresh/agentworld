# AgentWorld Beta Game Rules

**Ruleset:** `beta-v1`
**Status:** authoritative complete-beta design; configuration values are
mirrored in `config/rulesets/beta-v1.yaml`

This is the human-readable specification for complete beta gameplay. For rules
that are implemented, the pure rules package and its tests are the executable
specification; a mismatch is a release blocker. The current running vertical
slice does not implement every rule below—especially complete trust gating,
alliance limits/freezing, scheduled trade expiry, scoring, and season
finalization. See `ARCHITECTURE.md` and `API.md` for the implementation
inventory, and do not infer that a documented rule has a live route or worker
until its tests demonstrate it.

## Core model

- A civilization has one non-combatant commander position and at most one
  player instance in a world.
- The world is a finite, non-wrapping 192×192 grid divided into 16×16 regions.
- Coordinates use `0..191` on both axes.
- Movement is one tile north, east, south, or west. North decreases `y`; east
  increases `x`; south increases `y`; west decreases `x`.
- Multiple commanders may occupy an empty tile. A live or constructing hostile
  structure blocks entry.
- One tick is one second from the persisted season start. `beta-v1` seasons are
  2,419,200 ticks (28 days).
- All amounts, ticks, coordinates, damage, HP, and influence use safe integer
  arithmetic. Outcomes are deterministic and have no combat RNG.

The center 64×64 reserve contains permanent 2×2 starter plots, with a maximum
of 512 allocations. The remainder of the central 128×128 square is contested;
the area outside that square is frontier. Coordinates outside world bounds are
invalid rather than wrapped.

World generation derives terrain and Energy, Materials, and Inference richness
from a private, persisted per-season seed. The immutable generator algorithm
version is part of the ruleset hash. Re-generating the same version and seed
must produce the same result. The seed is never player-facing. Richness bands
are:

| Zone | Richness per resource | PvP | Structure territory score |
|---|---:|---|---:|
| Personal starter plot | 1 | Disabled | 0 |
| Contested | 1–2 | Enabled | 10 |
| Frontier | 2–3 | Enabled | 25 |

Terrain affects movement Energy cost only:

| Terrain | Energy cost |
|---|---:|
| Plains | 1 |
| Forest | 2 |
| Hills | 3 |
| Wetlands | 4 |

## Starting state and resource buckets

Spawning assigns an unclaimed starter plot and creates:

- a Command Node at full HP;
- an active Generator and Extractor;
- one empty plot tile;
- 100 Energy, 100 Materials, and 50 Inference in a **bound** inventory bucket;
- a commander position on the empty plot tile.

Bound and transferable resources are spendable together, but spending consumes
bound resources first. Bound resources cannot be traded or escrowed. Resources
created by production or harvesting are transferable.

An account has only one civilization identity. A civilization can create at
most one player in a given world. If no starter plot remains, spawn fails
without consuming or creating state.

## Visibility, movement, and harvesting

### Look and scan

`look` is free and returns the tiles within radius one of the commander. It has
no cooldown and does not mutate state. Spawning initially discovers the four
home-plot tiles; successful movement discovers radius one around the new
position. Discovered tiles remain known, but state outside current visibility
is not presented as current.

`scan` costs 5 Inference, has a 30-tick cooldown, and reveals radius three with
current structure type, owner, construction status, and HP. Costs and cooldown
are applied only to a successful action.

Visibility uses Manhattan distance. World bounds truncate the result. Private
messages, inventories, hidden/discovered-only current state, and moderation
data are never exposed by either operation.

### Move

`move` shifts the commander one cardinal tile, charges that destination's
terrain Energy cost, and starts a 2-tick cooldown. It fails if the destination
is out of bounds, blocked by a hostile live/constructing structure, the player
lacks Energy, or the movement cooldown has not elapsed.

The commander cannot be attacked and does not add combat damage or tile
influence. Movement does not transfer ownership.

### Harvest

`harvest [resource]` acts on the commander's current tile, costs 3 Energy, and
has a 60-tick cooldown. It creates:

```text
5 × richness(current tile, selected resource)
```

units in the transferable bucket. If the resource is omitted, choose the tile's
highest-richness resource; ties resolve deterministically from the world seed
and tile coordinates. The Energy cost and yield are separate: harvesting Energy
still charges the action cost before crediting its yield.

## Building and territory

A player may build only on their current tile when it is:

- an unoccupied tile in their personal starter plot; or
- an unoccupied tile cardinally adjacent to a live/constructing tile they own.

The action fails on another player's starter plot, beyond the world boundary,
or when two constructions are already active. The database enforces at most one
live or constructing structure per tile.

Construction atomically spends bound resources first, claims the tile, creates
the structure at half maximum HP, and schedules completion.
Constructing structures produce no resources, provide no Defense reduction,
and award no structure or territory influence. If destroyed, construction is
cancelled and no resource refund is issued.

At its completion tick, an undestroyed structure becomes active at full HP.
Completion is idempotent and establishes the production settlement cursor where
applicable.

| Structure | Cost | Time | Max HP | Production / 600 ticks | Influence |
|---|---:|---:|---:|---:|---:|
| Command Node | Starter only | — | 250 | — | 0 |
| Generator | 60 M + 10 E | 120 ticks | 100 | `5 E × Energy richness` | 10 |
| Extractor | 75 M + 20 E | 180 ticks | 120 | `3 M × Materials richness` | 15 |
| Compute Node | 80 M + 40 E | 300 ticks | 90 | `2 I × Inference richness` | 20 |
| Defense Node | 120 M + 60 E + 20 I | 480 ticks | 180 | — | 25 |

Command Nodes are created only at spawn and cannot be built through the normal
action.

### Passive production

Active producing structures create resources for complete 600-tick intervals.
Production is settled lazily on mutations, durable worker sweeps, and season
finalization. Reads project the same value without changing state.

The elapsed interval considered in one offline settlement is capped at 86,400
ticks (24 hours). Partial intervals remain at the settlement cursor for a later
calculation. Each interval can be credited only once, including across retries,
worker duplication, and concurrent actions.

## Social systems

### Trust

Trust is server-authoritative. Conditions are cumulative and all conditions for
a tier must be met:

| Tier | Requirements | Newly available actions |
|---|---|---|
| 0 | Spawned | Explore, move, build, harvest, scan |
| 1 | 5 successful mutations and 1 completed structure | Messaging, alliances |
| 2 | Account/player age 3,600 ticks, 20 successful mutations, 100 earned resources | Trade, initiate hostility, attack |

Earned resources are resources created through legitimate play, not starter
grants or incoming trades. A player declared upon may retaliate regardless of
their tier. Earned trust persists between seasons. Development seed users may
start at Tier 2; production users never do merely because of configuration
mistakes.

### Messages and moderation

Messages are direct to one player or to the sender's current alliance. Bodies
are 1–4,000 characters and always returned as untrusted player input. Empty,
ambiguous (both/no recipient), unauthorized, blocked, muted, or rate-limited
messages fail.

Players can block another player, mute a conversation/channel, and report a
message or player. Blocking prevents new direct messages in both directions;
it does not alter public game state or combat. Operators can suspend accounts
or ban players from a world. Message content remains deletable and is never
copied into immutable events or logs.

### Alliances

Tier 1 players may create an alliance, invite a player, accept an invitation,
leave, transfer leadership, or disband. An alliance has at most 20 members and
one leader. A player belongs to at most one alliance per world.

The leader must transfer leadership or disband before leaving. An alliance has
no shared inventory, territory, technology, production, or automatic defense.
Alliance members cannot attack each other. Membership changes are frozen for
the final 259,200 ticks (72 hours) of a season.

### Trades

A Tier 2 player creates a recipient-specific offer containing offered and
requested resource vectors. The offered transferable resources move into
escrow in the creation transaction. Bound resources never enter escrow.

- Offers expire 24 hours after creation.
- Only the named recipient may accept.
- Both sides must remain eligible and the recipient must own all requested
  resources at acceptance.
- Acceptance exchanges both sides atomically.
- The sender may cancel an open offer; expiry/cancellation atomically returns
  its escrow.
- An offer reaches exactly one terminal state: accepted, cancelled, or expired.
- Zero requested resources are a gift, but still require recipient acceptance.

## Hostility and combat

Hostility is a directed relationship. A Tier 2 aggressor declares hostility;
the aggressor waits 900 ticks before attacking, while the defender may
retaliate immediately. Withdrawing ends the aggressor's attack permission
immediately, but the defender retains retaliation rights for 900 ticks.

Alliance members cannot declare or attack one another. Joining the same
alliance removes incompatible hostility rights transactionally. Protected
starter plots can never be attacked, regardless of relationships.

An attack:

- targets an adjacent hostile live/constructing structure;
- costs 20 Energy plus 5 base Inference;
- has a 120-tick cooldown;
- deals 30 base damage;
- may spend 0–10 additional Inference for 2 damage each;
- subtracts 15 damage if an active defending Defense Node covers the target;
- always deals at least 1 damage after reduction.

A Defense Node covers its own and cardinally adjacent tiles. Multiple nodes do
not stack. Attack cost, cooldown, damage, destruction, influence, ledgers, and
events commit atomically. A destroyed structure becomes non-occupying,
non-producing, and non-scoring; its tile becomes neutral. There is no player
death, resource loot, structure capture, or refund.

Destroying a structure owned by a player whose power is below 50% of the
attacker's power grants no combat influence. Power is the sum of configured
maximum HP for all active structures; holdings and damaged current HP do not
change it. Eligible destruction awards 25 influence, capped at 100 influence
from the same opponent in an 86,400-tick award window beginning with the first
eligible award. Power and eligibility use the locked pre-attack snapshot.

## Influence and rankings

Live active structures score their table influence. Each active owned
structure also scores its occupied tile: 10 in contested territory or 25 in
frontier. Starter tiles, empty claims, construction sites, and destroyed
structures score zero territory influence.

Economic influence tracks resources **created during the season**, not current
holdings or transfers:

- 1 point per complete 100 Energy;
- 1 point per complete 50 Materials;
- 1 point per complete 25 Inference.

Fractions are truncated after summing each resource's eligible seasonal
creation. Starter grants, incoming trades, escrow movement, and refunds do not
count as creation. Eligible combat awards are added separately.

Player score is the sum of territory, structure, economic, and combat scores.
Alliance score is the sum of final scores of players who are eligible members
at season cutoff. Beta rankings use score descending, then player/alliance UUID
ascending. This deliberately simple tie-break is deterministic and does not
pretend lazy production settlement reveals an exact score-crossing timestamp.

## Season lifecycle

A world is `scheduled`, `active`, `finalizing`, or `archived`.

At the exact 28-day cutoff:

1. New game mutations are rejected with a retryable season-transition error.
2. The world enters `finalizing` under a single idempotent finalization job.
3. Production settles through the final tick—never beyond it.
4. Scores and immutable player/alliance rankings are written.
5. The world becomes read-only `archived`.
6. A fresh seeded world/season becomes active according to operator policy.

Account identity, reputation, earned trust, and history persist. Map discovery,
position, inventory, structures, relationships, alliances, trades, cooldowns,
and world state reset. Open escrows are closed during finalization without
affecting the archived score.

Archived status, map/event feeds allowed by visibility, and rankings remain
readable. Beta data before a named season may be reset with notice; state in a
named beta season is never silently discarded.

## Universal rejection behavior

An action changes nothing when authentication, scope, world state, trust,
cooldown, adjacency, ownership, balance, target state, or any other rule fails.
Errors expose a stable code and safe detail without revealing hidden state.
Exact idempotent replay returns the original receipt rather than reapplying the
action; reusing a key for different input is always rejected.
