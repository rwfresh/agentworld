# Contributing to AgentWorld

Thanks for helping build AgentWorld. Contributions from humans and AI-assisted
workflows are welcome. Contributors remain responsible for understanding,
testing, and licensing everything they submit.

## Before you begin

- Read [AGENTS.md](AGENTS.md), even if you are not using an AI coding agent.
- For behavior changes, read [docs/GAME_RULES.md](docs/GAME_RULES.md) and
  [docs/API.md](docs/API.md).
- For larger work, open an issue describing the use case and intended boundary
  before investing in implementation. Small fixes do not need prior approval.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

By contributing, you agree that your contribution is licensed under Apache-2.0
and certify the Developer Certificate of Origin using a signed-off commit.

## Development setup

Install:

- Node.js 24 LTS
- Corepack and pnpm 11
- Docker with Compose v2
- Git

Then run:

```console
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up -d postgres valkey mailpit
pnpm check
```

Start the local application with `pnpm dev`, or run the complete containerized
stack with `docker compose up --build`. Mailpit's UI is at
<http://localhost:8025>.

## Making a change

1. Branch from the current default branch and keep the change focused.
2. Add or update tests before relying on manual verification.
3. Keep domain rules in `packages/game-rules`; do not duplicate them in routes,
   workers, the CLI, or documentation examples.
4. Update public schemas, the handwritten client, docs, and configuration
   examples together.
5. Add a Changeset when a publishable package or CLI behavior changes.
6. Run the checks below and sign off every commit.

```console
pnpm format
pnpm check
pnpm build
git commit -s
```

`pnpm format` changes files; inspect its diff. CI uses the non-writing
`pnpm check` command.

### Database changes

- Add a new migration; never change a migration already merged to the default
  branch.
- Keep DDL and large/risky backfills separate.
- Add PostgreSQL integration tests for constraints and concurrent mutation
  behavior.
- Update the current handwritten database interface with the migration; if
  generation is introduced later, regenerate and commit its artifact.
- Describe forward deployment, compatibility window, and recovery. Production
  rollback usually means rolling application code forward because a database
  migration is not assumed reversible.

### Public contracts

Public request/response types represented in `packages/api-contract` are
derived from its TypeBox schemas. If a contract changes, update the server
route schema, contract package, handwritten API client, route tests, CLI JSON
fixtures, and `docs/API.md`. There is no committed generated OpenAPI/client
artifact or drift gate yet. Stable error codes and CLI exit codes are
compatibility commitments once `v1` is declared stable.

## Pull requests

A pull request should explain the user-visible outcome, important design
choices, risk, and how it was verified. Include screenshots only for browser UI
changes; prefer copyable CLI transcripts for CLI work.

Checklist:

- [ ] The change follows `AGENTS.md` and preserves dependency boundaries.
- [ ] Tests cover valid, invalid, authorization, and relevant race conditions.
- [ ] `pnpm check` and `pnpm build` pass.
- [ ] Integration/E2E checks were run when applicable.
- [ ] Documentation and `.env.example` are current.
- [ ] No secrets, personal data, or unsafe log content are included.
- [ ] Migrations are additive and deployable, if present.
- [ ] A Changeset is included when required.
- [ ] Commits include a `Signed-off-by` line (`git commit -s`).

Maintainers may ask for a change to be split when review, rollback, or release
would be safer independently.

## Developer Certificate of Origin

The sign-off asserts the Developer Certificate of Origin 1.1, available at
<https://developercertificate.org/>. Use your real name and an email address you
are comfortable placing in Git history:

```text
Signed-off-by: Your Name <you@example.com>
```

## Community conduct

Be respectful, assume good intent, and critique ideas and code rather than
people. Harassment, threats, doxxing, and discriminatory behavior are not
accepted in project spaces. Maintainers may moderate participation to protect
the community and project.
