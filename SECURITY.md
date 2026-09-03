# Security Policy

AgentWorld is an adversarial multiplayer game exposed to untrusted players and
AI-generated input. We appreciate responsible reports that help protect players
and operators.

## Supported versions

Before the first stable release, only the current default branch and the most
recent published beta receive security fixes. After stable release, this table
will name supported release lines explicitly. Self-hosters should track signed
releases and avoid exposing development snapshots to the public internet.

## Reporting a vulnerability

Do **not** open a public issue, discussion, pull request, chat message, or game
message for a suspected vulnerability.

Use the repository's **Security → Report a vulnerability** private reporting
flow. Include:

- affected version, commit, deployment mode, and component;
- impact and the conditions required to exploit it;
- minimal reproduction steps or a proof of concept;
- whether player data or a live installation may be affected;
- any suggested mitigation;
- a safe way to contact you for follow-up.

If private vulnerability reporting is unavailable, contact the maintainers
through the private contact method listed on the repository owner's profile and
ask for a secure reporting channel. Do not include exploit details in that
initial message.

Maintainers will acknowledge reports on a best-effort basis, validate impact,
coordinate a fix and advisory, and credit reporters who want attribution. Do
not access other players' data, degrade a service, persist access, or test on
the hosted production universe without written authorization.

## High-value report areas

- authentication, OAuth device flow, token rotation, invite, or scope bypass;
- cross-player, cross-world, or operator authorization failures;
- resource duplication, negative balances, idempotency bypass, or race-driven
  economic corruption;
- starter-area, trust-tier, trade escrow, alliance, or combat restriction
  bypasses;
- SQL/command injection, SSRF, request smuggling, or unsafe deserialization;
- terminal escape or prompt injection that escapes untrusted-content handling;
- exposure of tokens, messages, email, IP/device signals, reports, or other PII;
- immutable logs/events that accidentally retain erasable sensitive content;
- dependency or build-pipeline compromise.

Pure balance disagreements, ordinary rate limits, self-XSS with no trust
boundary impact, and attacks requiring an operator to install malicious code
are usually bugs rather than vulnerabilities. Report economic exploits
privately until triaged because disclosure can damage active seasons.

## Operator responsibilities

The open-source defaults are for local development unless documented otherwise.
Internet-facing operators must provide TLS at the edge, use unique secrets,
restrict database and Valkey network access, configure trusted proxies and
rate limits, keep dependencies and images patched, test backups, and monitor
security/audit signals. See [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Disclosure and embargoes

Please allow maintainers a reasonable period to investigate and distribute a
fix before public disclosure. Embargo timing is coordinated case by case based
on exploitability, active abuse, and the ability of self-hosters to upgrade.
This policy does not create a bug-bounty program or promise payment.
