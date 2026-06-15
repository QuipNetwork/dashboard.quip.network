// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BabeAuthorityRecord,
  BabeEpochState,
  BlockRecord,
  ChainHead,
  ChainMinerRecord,
  DifficultyRecord,
  ValidatorAuthorshipRecord,
} from "./chain";
import type {
  CurrentDispatch,
  MinerStats,
  MiningSubmissionRecord,
  ModeBreakdown,
} from "./miner";
import type { NodeDescriptorRecord, NodesSnapshot } from "./node";

/**
 * Observability snapshot written by the indexer on every successful poll.
 * v0.3 drops the dual-cursor epoch/blockIndex model — the chain is now the
 * canonical block source, so we only track:
 *   - REST heartbeat: `lastStatusFetchAt` ticks every /api/v1/status poll.
 *   - Substrate heartbeat: `lastSubstrateEventAt` ticks on every head event.
 *   - `chainHeadFromNode`: best block height the locally polled quip-node
 *     reports via /api/v1/status.chain.head_number — null pre-first-fetch.
 *   - `minerStats`: latest /api/v1/stats payload, attached here so the UI
 *     can render miner tiles without a separate fetch.
 */
export interface IndexerObservability {
  // u64 as string — substrate block heights kept as strings throughout the
  // dashboard for consistency and u64-precision safety.
  chainHeadFromNode: string | null;
  lastStatusFetchAt: string; // ISO 8601
  lastBlockInsertAt: string | null;
  lastSubstrateEventAt: string | null;
  // Best/finalized substrate block heights, mirrored from chain_head for the
  // SyncIndicator. u64 as string. Null pre-first-event.
  bestBlockHeight: string | null;
  finalizedBlockHeight: string | null;
  // Live WSS socket state. Always false on a fresh process — only flips true
  // after the substrate worker's client emits a `connected` event.
  chainConnected: boolean;
  // True only after a live /api/v1/status probe confirmed the local miner's
  // ss58. selfAddress set + selfIdentified false = configured (e.g. via
  // QUIP_OPERATOR_ACCOUNT) but miner unreachable — the otherwise-silent case.
  selfIdentified?: boolean;
  minerStats: MinerStats | null;
  // Per-backend breakdown from the multi-process aggregator's last
  // /api/v1/status response. `{}` for single-process miners. UI
  // renders one row per active mode under the headline counters so
  // operators can see "qpu produced 0 proofs in the last 10s while
  // cpu produced 5" without parsing miner ids.
  //
  // Optional so persisted v16 observability rows + existing test
  // fixtures parse cleanly; consumers default to `{}` when reading.
  modes?: Record<string, ModeBreakdown>;
}

export interface TelemetryResponse {
  blocks: BlockRecord[];
  // SS58 of the locally polled quip-node, sourced from /api/v1/status.
  // Null until the indexer has completed its first successful poll.
  selfAddress: string | null;
  // Indexer/node tip observability. null before the indexer has completed
  // its first successful /status poll after deploy.
  indexer: IndexerObservability | null;
  // ISO 8601 timestamp the server stamped this response. Lets the UI
  // compute observability ages relative to server time, not client clock.
  serverTime: string;
  // Substrate-derived snapshots. Null/empty when the substrate worker
  // hasn't connected to any endpoint in QUIP_VALIDATOR_RPC_URLS yet —
  // degrades gracefully to chain-less mode.
  chainHead: ChainHead | null;
  babeEpoch: BabeEpochState | null;
  babeAuthorities: BabeAuthorityRecord[];
  chainMiners: ChainMinerRecord[];
  // Recent DifficultyRecord snapshots (most recent first).
  recentDifficulty: DifficultyRecord[];
  // Active BABE authority set joined with per-validator authorship counters.
  // Empty when no BABE epoch has been polled yet.
  validators: ValidatorAuthorshipRecord[];
  // Snapshot of network nodes, projected server-side from the
  // `node_descriptors` table the indexer populates from
  // `System.remark_with_event` extrinsics. Null when no descriptor has
  // been observed yet (fresh chain or pre-deploy operators). Drives the
  // Compute Available view's TFLOPS/PFLOPS surfaces.
  nodes: NodesSnapshot | null;
  // Per-account indexed descriptors — raw signed payloads plus provenance.
  // Empty when no `quip-miner identify` extrinsic has been seen. Drives
  // the Node Identities panel and joins into ChainMinersTable.
  nodeDescriptors: NodeDescriptorRecord[];
  // Recent submissions by the locally-polled miner, sourced from
  // `/api/v1/mining/attempts?solution_number=N` on the miner. Newest
  // first, capped at `RECENT_MINING_SUBMISSIONS_LIMIT` on the server.
  // Drives the "Recent Performance" panel — click a row to fetch the
  // iteration trail via `/api/mining/attempts/:solutionNumber`. Empty
  // when the miner has not submitted a proof since the indexer started
  // polling.
  recentMiningSubmissions: MiningSubmissionRecord[];
  // Lifetime count of distinct solution_numbers the indexer has recorded
  // for self where the iteration list was non-empty — drives the
  // "Problems Attempted" tile on the Mining Performance card. Counts
  // problems, not dispatches: a controller that re-dispatches the same
  // LastProofBlock won't double-count here. Zero until selfAddress
  // resolves or the indexer's first submission lands.
  selfProblemsAttempted: number;
  // The miner's work against the current global solution_number — either
  // the in-flight problem (status "in-flight", `solution_number =
  // Σ proofsWon + 1`, which the miner is actively grinding) or the
  // just-finished one (status "completed", `Σ proofsWon`) when the next
  // hasn't produced iterations yet. Null when the network has no wins
  // yet, or when both probes failed. The UI uses `status` to label the
  // panel header and joins `solutionNumber` against
  // `recentMiningSubmissions` to surface the chain outcome (e.g.
  // chain_error vs submitted_inblock).
  currentDispatch: CurrentDispatch | null;
}

export interface ErrorResponse {
  error: string;
  detail?: string;
}
