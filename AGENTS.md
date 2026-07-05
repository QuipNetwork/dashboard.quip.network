# AGENTS.md

Cross-tool agent guidance for the Quip Dashboard monorepo. Human contributors:
see [`README.md`](README.md) for setup and deployment.

## Layout & boundaries

Bun-workspaces monorepo — `apps/*` + `packages/*`:

- `@quip/shared` (`packages/shared`) — zero-dependency telemetry types; the
  shared contract every workspace agrees on.
- `@quip/core` (`packages/core`) — Postgres/Kysely `DatabaseAdapter` + `migrations/`.
- `@quip/indexer`, `@quip/server`, `@quip/frontend` (`apps/*`) — runnable apps.

Dependency direction (do not violate): `shared ← core ← {indexer, server}`, and
**`frontend` depends on `@quip/shared` only**. Never import `@polkadot/*` outside
`apps/indexer/clients/substrate-client/` — the frontend cannot reach it by design,
and the `verify:no-polkadot-in-bundle` build guard enforces it. Internal packages
export TypeScript source directly (no build step).

## Database

Postgres-only, via Kysely. A schema change is a **new additive migration** under
`packages/core/migrations/` (numbered, registered in `migrations/index.ts`) — there
is no `SCHEMA_VERSION` / wipe-on-drift. Apply with `bun run migrate`.

## Commands

The host needs no JS runtime; run via `./run` (`dev`, `build`, `typecheck`, `test`,
`format`). `./run build` builds the container **image**; the in-image `bun run build`
builds the **SPA** (`apps/frontend/dist`).

## Branches

`v0.2` is the long-lived integration branch — target feature MRs at `v0.2`, not `main`.

## Versioning & release tags

Canonical doc: `quip-protocol/docs/VERSIONING.md`. Git release tags use
**hyphenated SemVer**; package-manifest versions use the toolchain's native format.

| Artifact                                      | Format                   | Example       |
| --------------------------------------------- | ------------------------ | ------------- |
| Git release tag (pre-release)                 | `vMAJOR.MINOR.PATCH-rcN` | `v0.2.1-rc18` |
| Git release tag (stable)                      | `vMAJOR.MINOR.PATCH`     | `v0.2.1`      |
| Package version (PEP 440 / Cargo, where req.) | toolchain-native         | `0.2.1rc18`   |

Rules:

- Pre-release git tags MUST be hyphenated (`-rcN` / `-alphaN` / `-betaN`) — never
  the no-hyphen PEP 440 form for a git tag. (`quip-node-manager`'s SemVer parser
  splits the pre-release on the hyphen; a no-hyphen tag collapses the patch + rc
  number, so every rc compares equal and deployed nodes freeze on an old rc.)
- Numeric parts (MAJOR.MINOR.PATCH and the rc number) must match between the git
  tag and the package version; only the separator differs.
- CI: pre-release tags publish `:<tag>` + the rolling `:vMAJOR.MINOR`, and MUST NOT
  move `:latest`. Only `main` / a stable `vX.Y.Z` tag moves `:latest`.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
