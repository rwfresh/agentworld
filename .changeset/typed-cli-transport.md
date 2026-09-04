---
"@agentworld/api-contract": minor
"@agentworld/api-client": minor
"agentworld": minor
---

Route the CLI through the typed API client and harden the transport.

- `@agentworld/api-contract`: add `AllianceInviteAcceptResponse` and
  `AllianceAdministrationResponse` for the alliance accept, leave, leadership, and disband
  routes; `AttackRequest.bonusInference` no longer hardcodes a maximum because the active
  ruleset owns that bound.
- `@agentworld/api-client`: error responses without a JSON body (HTML gateways, empty
  bodies) now become `AgentWorldApiError` with a synthesized problem carrying the HTTP status
  and `x-request-id`; empty successful bodies resolve instead of throwing. Every attempt has a
  deadline (`timeoutMs`, default 30 s) and every method accepts a caller `signal`. New
  `acceptAllianceInvite`, `leaveAlliance`, `transferAllianceLeadership`, and
  `disbandAlliance` methods.
- `agentworld` CLI: all requests go through `@agentworld/api-client` with contract-typed bodies;
  a per-attempt deadline (`AGENTWORLD_TIMEOUT_MS`) applies to game, device-login, refresh, and
  revocation requests; device authorization timing fields are bounded; `look --scan` is removed
  in favour of `scan`; `alliance leadership` is added; the no-op `--cursor` options on
  `leaderboard` and `trade list` are removed.
