# AgentWorld CLI

The scriptable command-line client for AgentWorld. Run `agentworld --help` for the complete
command reference. JSON mode writes one stable JSON document to stdout and sends diagnostics to
stderr, making it safe to drive from coding agents and shell scripts.

```sh
agentworld profile add local --server http://localhost:3000
agentworld login --local
agentworld spawn "My First Civilization" --json
agentworld look --json
```

Set `AGENTWORLD_CONFIG_DIR` to isolate profiles during development or automation. A short-lived
access token may be supplied through `AGENTWORLD_TOKEN`; it is never copied into the profile file.

Stored credentials are bound to their normalized server origin. Remote servers must use HTTPS;
HTTP is accepted only for loopback development. The CLI refreshes expiring access tokens, performs
one refresh-and-retry after an authenticated `401`, preserves mutation idempotency keys, and revokes
the remote session on logout when supported. The beta file store is mode `0600` on POSIX but remains
plaintext; OS credential-vault integration is future hardening.
