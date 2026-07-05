# Qblock-Driven Winner Indexing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the indexer pegging the validator (~1300–2200% CPU) during winner backfill by replacing per-winner-block full-block decoding + redundant runtime calls with targeted storage reads.

**Architecture:** The pipeline shape is unchanged: "enumerate integers in a domain → decode each → hand a `BlockContext` to plugins." Phase 1 changes only what *decode* does for winner blocks (drop `derive.chain.getBlock`, cache topology, drop the duplicate `winningSolution`). Phase 2 (separate, later) swaps the winner enumeration unit from block-height to qblock-id, which first requires namespacing queue items by lane.

**Tech stack:** TypeScript, Bun, `@polkadot/api`, RxJS pipeline (`apps/indexer/pipeline`), Postgres/Kysely.

## Global Constraints

- Idempotent writes: running a plugin twice for the same block leaves one row (`BlockIndexable.onBlock` contract, `plugin.ts:60`).
- No behaviour change to the `blocks` row contract (`BlockRecord` in `@quip/shared/telemetry`): every field currently written by `winners.ts` must still be written with the same value.
- The authorship `startBlock → head` change (already applied in `plugins/authorship.ts`) stays.
- Keep the coverage/lane/walker/tip scaffolding (`coverage.ts`, `producers.ts`, the walker, `dispatch.ts` driver) intact in Phase 1.
- Evidence of correctness is a fresh-index run (`DROP SCHEMA public CASCADE` on the dev DB, restart `deploy-app-1`) with `quip-validator` CPU monitored — target: no sustained multi-hundred-percent spike.

---

## Verified runtime facts (from live probing, 2026-07-05)

- `winningSolution(blockNumber)` runtime API (`quantumPowApi.winningSolution`) returns `Option<{ solution, nonce }>` where `solution` carries: `miner`, `energyMilli`, `reward`, `submittedAt` (block number), `difficulty {minSolutions, maxEnergyMilli, minDiversityMilli}`, `topologyHash`, `lastProofBlockHash`, `deviceAccessTimeUs`. (`getQBlock` / `qblockInfoFromSolution` already decode a subset.)
- **Not** in `winningSolution`: `diversity` and `numValidSolutions`. Those are event-only (`ProofAccepted`). `blockBestProof` is a plain (current-block-only) storage value — it takes no key, so it cannot supply historical proof detail.
- `diversity` + `numValidSolutions` are still consumed by the UI (`LastQBlockCard.tsx`, `QBlockDetailsModal.tsx`, `RecentMiningPanel`), so they must keep being written.
- Only 1 distinct `topology_hash` exists across all indexed blocks — topology is effectively static and must be cached, not re-derived per block.

---

## Task 1: Topology-by-hash cache in the substrate client

**Files:**
- Modify: `apps/indexer/clients/substrate-client/index.ts` (the topology read path used by `getTopology` / `getDefaultTopologyAt` / topology metadata runtime calls).
- Test: `apps/indexer/clients/substrate-client/*.test.ts` (or a focused new test file).

**Interfaces:**
- Produces: a per-connection cache `topologyByHash: Map<string, TopologyInfo>` so that resolving `{nodeCount, edgeCount}` for a known `topologyHash` costs one runtime call the first time and zero after.

**Steps:**
- [ ] Write a failing test: two resolutions of the same topology hash issue only one underlying runtime call (spy/fake the client's topology RPC).
- [ ] Implement a `Map<hash, TopologyInfo>` cache keyed by `topologyHash`, populated on first resolve, cleared on disconnect (per-connection lifetime, like other memoized state).
- [ ] Verify the test passes; confirm `getTopology`/topology-metadata callers hit the cache.
- [ ] Commit.

## Task 2: Targeted winner decode (`decodeWinnerBlock`)

**Files:**
- Modify: `apps/indexer/clients/substrate-client/index.ts` — add a method that, given a block number, returns the enrichment a winner row needs WITHOUT `derive.chain.getBlock`.
- Test: substrate-client test.

**Interfaces:**
- Consumes: `winningSolution(blockNum)` (Task uses existing `getQBlock` internals), `api.query.system.events.at(blockHash)`, `getBlockHash`, `timestamp.now.at`.
- Produces: enough to build a `BlockRecord`. Concretely, extend the winner path so `BlockContext.events` for a winner item is populated from `system.events.at(hash)` (only the `ProofAccepted` → `diversityMilli`, `validSolutionCount`, and `BlockWinner` → miner/energy/reward/qblockId/nonce) rather than a full `SignedBlockExtended` decode. `author` is left `null` for winner-only decode (authorship no longer backfills — it runs at tip via the every-block path).

**Steps:**
- [ ] Write a failing test: `decodeWinnerBlock(blockNum)` returns a `BlockEvents`-shaped object with `winner`, `proofs` (diversity + validSolutionCount), and `nonce`, using only `events.at` + `winningSolution` (assert no `derive.chain.getBlock` call via a spy).
- [ ] Implement `decodeWinnerBlock`: `getBlockHash(blockNum)` → `system.events.at(hash)` filtered to `quantumPow.BlockWinner` + `quantumPow.ProofAccepted`; nonce from the winning `submit_proof` extrinsic OR from `winningSolution().nonce` (prefer the runtime value — it's already fetched and avoids extrinsic decode). Reuse `qblockInfoFromSolution` for the qblock fields.
- [ ] Verify diversity + numValidSolutions match what the full-decode path produced for a sample block (golden test against current `decodeFinalizedBlock` output for one known winner).
- [ ] Commit.

## Task 3: Route the winner lane through the targeted decode + de-dupe

**Files:**
- Modify: `apps/indexer/pipeline/dispatch.ts` (`process`) — for items whose pending set is winner-domain only, fetch via `decodeWinnerBlock` instead of `processFinalizedBlock`; build `BlockContext.qblock()` from the already-fetched solution (no second `winningSolution`); resolve `topology()`/`defaultTopologyAt()` via the Task 1 cache.
- Modify: `apps/indexer/clients/substrate-client/index.ts` — ensure `getQBlock`'s result is threaded onto the context so `winners.ts` `ctx.qblock()` reuses it (kills the duplicate runtime call, subagent finding #2).
- Test: `apps/indexer/pipeline/dispatch.test.ts`.

**Interfaces:**
- Consumes: Task 1 cache, Task 2 `decodeWinnerBlock`.
- Preserves: the `winners.ts` and `difficulty.ts` `onBlock` bodies unchanged — they still consume `BlockContext` with the same shape.

**Steps:**
- [ ] Write a failing test: a winner-only item is processed with zero `derive.chain.getBlock` and exactly one `winningSolution` call; the resulting `blocks` row equals the current pipeline's row for the same fixture.
- [ ] Implement the routing in `process`: detect winner-only items; use `decodeWinnerBlock`; memoize `qblock()` from the fetched solution; use cached topology.
- [ ] Keep the every-block/tip path on `processFinalizedBlock` (authorship at tip still needs author + events).
- [ ] Run `dispatch.test.ts` + `plugins.test.ts` + `reindex.test.ts`; verify green.
- [ ] Commit.

## Task 4: Fresh-index measurement

**Steps:**
- [ ] `docker stop deploy-app-1`; `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` on `deploy-postgres-1`; `docker start deploy-app-1`.
- [ ] Monitor `quip-validator` CPU for ~10 min (30s cadence). Record peak + steady state.
- [ ] Compare to the pre-change baseline (1300–2200% during winner backfill). Success = winner backfill no longer pegs the validator (target: low hundreds of % or less), blocks row counts and values unchanged.
- [ ] Record results in this plan file under a "## Results" heading.

---

## Phase 2 (separate plan, after Phase 1 is measured): qblock-id enumeration

Swap the winner lane's enumeration from `getQBlockNumbers()` (sparse block heights) to `[floor..qBlockCount]` (dense qblock ids). **Blocked on** namespacing queue/walker work items by lane first — today `queue.complete(block)` / `walker.notifyCompleted(block)` key by a bare integer, so qblock-id `4196` would collide with block-height `4196`. Design the namespacing (e.g. `{lane, n}` keys or per-lane queues) before touching enumeration. Deferred intentionally; Phase 1 delivers the CPU win without it.
