---
"@agentworld/api-contract": minor
"@agentworld/api-client": minor
"agentworld": minor
---

Surface hostility and combat events to their targets and add relationship and invitation reads.

- `@agentworld/api-contract`: `EventSummary` gains an optional `targetPlayerId` naming the player
  an event was done to. New `RelationshipRole`, `RelationshipState`, `RelationshipView`, and
  `RelationshipListResponse` type `GET /v1/worlds/{worldId}/relationships`; new
  `AllianceInviteView` and `AllianceInviteListResponse` type
  `GET /v1/worlds/{worldId}/alliance-invites`; `AllianceLeadershipRequest` moves into the
  contract from the server so the leadership route, client, and CLI share one schema.
- `@agentworld/api-client`: new `relationships(worldId)` and `allianceInvites(worldId)` reads.
  `transferAllianceLeadership` now takes an `AllianceLeadershipRequest` body instead of a bare
  player id.
- `agentworld` CLI: new `hostility list` and `alliance invites` commands.
