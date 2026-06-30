// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MinerHardwareRecord } from "./miner";

/**
 * A PoW block as recorded by the dashboard. Substrate is the canonical source
 * in v0.3 — the substrate worker subscribes to quantum_pow's
 * `BlockWinner` + `ProofAccepted` event pairs (in `on_finalize`) and inserts
 * one row per substrate block whose PoW win is accepted. `blockHash` is the
 * PoW solution hash and serves as the table PK. All substrate_* fields are
 * populated at insert time — there is no two-phase enrichment in v0.3.
 */
export interface BlockRecord {
  blockHash: string;
  // u64 as string — substrate block heights kept as strings throughout the
  // dashboard for consistency and u64-precision safety. Indexer/UI convert to
  // Number for display/arithmetic at the boundary.
  substrateBlockNumber: string;
  substrateBlockHash: string;
  substrateParentHash: string;
  timestamp: number;
  minerId: string;
  energy: number;
  diversity: number;
  numValidSolutions: number;
  miningTime: number;
  // u128 as string (token amount).
  reward: string;
  // Monotonic 1-based qblock id this win was assigned on chain (u64 as
  // string) — the per-block "solution number". Sourced from the v0.2
  // `quantum_pow.BlockWinner` event's `qblock_id` field.
  qblockId: string;
  // u64 as string — nonce can exceed Number.MAX_SAFE_INTEGER.
  nonce: string;
  numNodes: number;
  numEdges: number;
  difficultyEnergy: number;
  minDiversity: number;
  minSolutions: number;
  finalized: boolean;
  // H256 (0x hex) of the chain's default topology at index time, or null for
  // rows written before topology tagging (and on chains with no default
  // topology). The API scopes the block/chart surfaces to the chain's current
  // default topology so the charts reset when the default topology changes,
  // without destroying history.
  topologyHash: string | null;
}

export interface RuntimeVersion {
  specName: string;
  specVersion: number;
  transactionVersion: number;
  implName: string;
  // Block number (u64 as string) at which the active runtime was last
  // upgraded. Null when the chain has never upgraded since genesis.
  lastRuntimeUpgrade: string | null;
}

/**
 * Best/finalized substrate chain heads + runtime version. Single-row snapshot
 * written by the substrate worker on every head event (debounced). Null on
 * /api/telemetry when no substrate connection has been established yet
 * (indexer hasn't received its first head from any URL in
 * QUIP_VALIDATOR_RPC_URLS).
 */
export interface ChainHead {
  bestBlockNumber: string;
  bestBlockHash: string;
  finalizedBlockNumber: string;
  finalizedBlockHash: string;
  // bestBlockNumber - finalizedBlockNumber, precomputed for the UI.
  finalityLag: number;
  // Network-wide count of winning qblocks, sourced from the v0.2
  // `quantum_pow.QBlockCount` u64 (a single O(1) read; renamed from the
  // v0.1 `WinningSolutions` map length). This is the authoritative source
  // for the global "solution number": the in-flight problem every miner is
  // grinding is `qblockCount + 1`. Null when the chain doesn't
  // expose it yet or the substrate worker hasn't read it. Equals
  // `Σ chain_miners.proofsWon` when that table is complete, but sourced
  // straight from chain so it can't undercount.
  qblockCount: number | null;
  // The in-flight qblock id miners are currently racing — `QBlockCount + 1`
  // (i.e. `qblockCount + 1`). Null when the count is unknown.
  currentQBlockId: string | null;
  // Number of miners that declared participation on `currentQBlockId` via
  // `MinerRegistry.participate` (from the `participant_count_by_qblock`
  // runtime API). Null when the runtime API is absent (pre-v0.2) or the
  // count couldn't be read.
  currentQBlockParticipants: number | null;
  runtime: RuntimeVersion;
  updatedAt: string;
}

/**
 * Current per-topology difficulty for one topology on the chain's mineable
 * whitelist. v0.2 keys difficulty by topology hash; the substrate worker reads
 * the live decayed threshold via `QuantumPowApi::difficulty_for(hash)` plus
 * node/edge counts via `topology_meta(hash)`. This is a current-state snapshot
 * (overwritten each poll), not append-only history like `DifficultyRecord`.
 */
export interface MineableTopologyRecord {
  // H256 topology hash (0x hex).
  topologyHash: string;
  // True for the chain's `DefaultTopology` — the difficulty curve is
  // calibrated against it and it is always mineable.
  isDefault: boolean;
  // From chain `max_energy_milli / 1000` — proof energy must be ≤ this.
  difficultyEnergy: number;
  // From chain `min_diversity_milli / 1000`.
  minDiversity: number;
  // From chain `min_solutions` (integer units).
  minSolutions: number;
  nodeCount: number;
  edgeCount: number;
  // Energy-curve constant K for this topology: the mean-field slope of the
  // chain's (linear) energy curve, `energy_milli = -c * K` (c = per-mille curve
  // position). Lets the UI render a proof's difficulty as a curve position
  // `‰ = -energy * 1000 / K` instead of raw negative energy. Null when the
  // chain doesn't expose the topology's field/coupling specs (pre-v0.2) or they
  // can't be evaluated. Derived from `expected_gse`: see the indexer.
  curveConstant: number | null;
}

/**
 * Substrate BABE epoch state — the substrate-chain consensus rotation concept,
 * slot-based, typically ~2400 slots / ~4h on quip-protocol-rs spec_version 101.
 */
export interface BabeEpochState {
  epochIndex: number;
  // u64 as string — BABE slot can exceed Number.MAX_SAFE_INTEGER on long-running chains.
  currentSlot: string;
  // u64 as string. The slot at which this epoch began.
  epochStartSlot: string;
  // Constant from `api.consts.babe.epochDuration`. Typically 2400 on quip.
  slotsPerEpoch: number;
  // currentSlot - epochStartSlot, precomputed for the UI progress bar.
  currentSlotInEpoch: number;
  // Number of BABE authorities active in this epoch. Sourced from
  // `api.query.session.validators().length` since BABE rotates per session.
  authorityCount: number;
}

/**
 * Thin record for a BABE authority. quip-protocol-rs spec 101 does not use
 * FRAME staking, so there is no commission/exposure/nominator concept — just
 * the account ID that has authority to author blocks in the current session.
 */
export interface BabeAuthorityRecord {
  accountId: string;
  // Optional display name from `api.query.identity.identityOf()` if the
  // identity pallet is enabled. Null on quip-protocol-rs spec 101.
  displayName: string | null;
}

/**
 * Rich on-chain miner state from `pallet-quantum-pow`'s `Miners` storage.
 * This is the high-value chain surface for the dashboard's mining audience.
 */
export interface ChainMinerRecord {
  accountId: string;
  // Token deposit locked by the miner to participate. u128 as string.
  deposit: string;
  // Lifetime counters. u64 as string.
  proofsSubmitted: string;
  proofsWon: string;
  // u128 as string (token amount).
  rewardsEarned: string;
  // Joined server-side from `miner_hardware.nodeId` when the chain account
  // matches a known hardware row. Today only self has a miner_hardware row
  // (source='self'); future peer-query/chain-surface versions populate other
  // entries.
  telemetryNodeAddress: string | null;
  // Full hardware record joined server-side from `miner_hardware` when an
  // entry exists for this accountId. Null when no hardware data exists
  // (most miners today — only self is populated until peer-query lands).
  hardware: MinerHardwareRecord | null;
}

/**
 * Snapshot of `quantum_pow.Difficulty` at a specific substrate block.
 * Adjusted every `QuantumPowEpochLength` blocks (~100 = ~10min on spec 101).
 * Stored append-only in `difficulty_history` for the chart surface.
 *
 * Field names mirror BlockRecord (energy/diversity/solutions) for cross-table
 * consistency. The substrate worker divides the chain's `*_milli` integer
 * encoding by 1000 before writing.
 */
export interface DifficultyRecord {
  // u64 as string — substrate block number at which this snapshot was taken.
  observedAtBlock: string;
  // From chain `max_energy_milli / 1000` — proof energy must be ≤ this.
  // Named `difficultyEnergy` to match the field on BlockRecord.
  difficultyEnergy: number;
  // From chain `min_diversity_milli / 1000`.
  minDiversity: number;
  // From chain `min_solutions` (already integer-units; no conversion).
  minSolutions: number;
  observedAt: string; // ISO 8601
  // H256 (0x hex) of the chain's default topology when this snapshot was
  // taken, or null for rows predating topology tagging. Mirrors
  // BlockRecord.topologyHash so the difficulty chart scopes to (and resets
  // with) the current default topology.
  topologyHash: string | null;
}

/**
 * Per-validator authorship payload joined against the active BABE authority
 * set. Each row corresponds to one BABE authority for the current session;
 * the server fills `blocksAuthored` / `blocksAuthoredWithPow` from the
 * `validator_authorship` aggregate table and computes `online` at read
 * time from `lastAuthoredAt`. Counters are 0 and timestamps are null for
 * authorities that have not yet authored a block the indexer has seen.
 */
export interface ValidatorAuthorshipRecord {
  accountId: string;
  blocksAuthored: number;
  blocksAuthoredWithPow: number;
  // Substrate block number of the most recent head this validator authored,
  // as a u64-as-string. Null until the indexer has observed at least one
  // authored head from this account.
  lastAuthoredBlock: string | null;
  // ISO 8601. Null when no authored head has been observed.
  lastAuthoredAt: string | null;
  // True when `lastAuthoredAt` is within the freshness window (3 minutes
  // at the time of writing). Computed server-side against the request
  // wall-clock so the SPA doesn't have to choose a clock.
  online: boolean;
}
