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

| Artifact                                      | Format                    | Example       |
| --------------------------------------------- | ------------------------- | ------------- |
| Git release tag (pre-release)                 | `vMAJOR.MINOR.PATCH-rcN`  | `v0.2.1-rc18` |
| Git release tag (stable)                      | `vMAJOR.MINOR.PATCH`      | `v0.2.1`      |
| Package version (PEP 440 / Cargo, where req.) | toolchain-native          | `0.2.1rc18`   |

Rules:

- Pre-release git tags MUST be hyphenated (`-rcN` / `-alphaN` / `-betaN`) — never
  the no-hyphen PEP 440 form for a git tag. (`quip-node-manager`'s SemVer parser
  splits the pre-release on the hyphen; a no-hyphen tag collapses the patch + rc
  number, so every rc compares equal and deployed nodes freeze on an old rc.)
- Numeric parts (MAJOR.MINOR.PATCH and the rc number) must match between the git
  tag and the package version; only the separator differs.
- CI: pre-release tags publish `:<tag>` + the rolling `:vMAJOR.MINOR`, and MUST NOT
  move `:latest`. Only `main` / a stable `vX.Y.Z` tag moves `:latest`.
