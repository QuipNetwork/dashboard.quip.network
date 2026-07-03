// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BlockRecord,
  ChainHead,
  ChainMinerRecord,
  DifficultyRecord,
  MinerCategory,
  MinerHardwareRecord,
  MiningSubmissionRecord,
  NodeDescriptor,
  NodeDescriptorRecord,
} from "@quip/shared/telemetry";

type Row = Record<string, unknown>;
type ChainMinerLite = Omit<ChainMinerRecord, "telemetryNodeAddress" | "hardware">;

// TIMESTAMPTZ comes back as a Date; tolerate an ISO string from other drivers.
function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

// JSONB comes back parsed; tolerate a JSON string from other drivers.
function json<T>(v: unknown): T {
  return (typeof v === "string" ? JSON.parse(v) : v) as T;
}

// BIGINT/NUMERIC come back as strings; coerce where the domain wants a number.
function num(v: unknown): number {
  return Number(v);
}

export function rowToBlockRecord(r: Row): BlockRecord {
  return {
    blockHash: String(r.block_hash),
    substrateBlockNumber: String(r.substrate_block_number),
    substrateBlockHash: String(r.substrate_block_hash),
    substrateParentHash: String(r.substrate_parent_hash),
    timestamp: num(r.timestamp),
    minerId: String(r.miner_id),
    energy: num(r.energy),
    diversity: num(r.diversity),
    numValidSolutions: num(r.num_valid_solutions),
    miningTime: num(r.mining_time),
    reward: String(r.reward),
    qblockId: String(r.qblock_id),
    nonce: String(r.nonce),
    numNodes: num(r.num_nodes),
    numEdges: num(r.num_edges),
    difficultyEnergy: num(r.difficulty_energy),
    minDiversity: num(r.min_diversity),
    minSolutions: num(r.min_solutions),
    finalized: Boolean(r.finalized),
    topologyHash: r.topology_hash == null ? null : String(r.topology_hash),
  };
}

export function rowToChainHead(r: Row): ChainHead {
  return {
    bestBlockNumber: String(r.best_block_number),
    bestBlockHash: String(r.best_block_hash),
    finalizedBlockNumber: String(r.finalized_block_number),
    finalizedBlockHash: String(r.finalized_block_hash),
    finalityLag: num(r.finality_lag),
    qblockCount: r.winning_solutions_count == null ? null : num(r.winning_solutions_count),
    currentQBlockId: r.current_qblock_id == null ? null : String(r.current_qblock_id),
    currentQBlockParticipants:
      r.current_qblock_participants == null ? null : num(r.current_qblock_participants),
    runtime: {
      specName: String(r.spec_name),
      specVersion: num(r.spec_version),
      transactionVersion: num(r.transaction_version),
      implName: String(r.impl_name),
      lastRuntimeUpgrade: r.last_runtime_upgrade == null ? null : String(r.last_runtime_upgrade),
    },
    updatedAt: iso(r.updated_at),
  };
}

export function rowToBabeEpoch(r: Row): {
  epochIndex: number;
  currentSlot: string;
  epochStartSlot: string;
  slotsPerEpoch: number;
  currentSlotInEpoch: number;
  authorityCount: number;
} {
  return {
    epochIndex: num(r.epoch_index),
    currentSlot: String(r.current_slot),
    epochStartSlot: String(r.epoch_start_slot),
    slotsPerEpoch: num(r.slots_per_epoch),
    currentSlotInEpoch: num(r.current_slot_in_epoch),
    authorityCount: num(r.authority_count),
  };
}

export function rowToChainMiner(r: Row): ChainMinerLite {
  return {
    accountId: String(r.account_id),
    deposit: String(r.deposit),
    proofsSubmitted: String(r.proofs_submitted),
    proofsWon: String(r.proofs_won),
    rewardsEarned: String(r.rewards_earned),
  };
}

export function rowToDifficulty(r: Row): DifficultyRecord {
  return {
    observedAtBlock: String(r.observed_at_block),
    difficultyEnergy: num(r.difficulty_energy),
    minDiversity: num(r.min_diversity),
    minSolutions: num(r.min_solutions),
    observedAt: iso(r.observed_at),
    topologyHash: r.topology_hash == null ? null : String(r.topology_hash),
    source: r.source === "block" ? "block" : "poll",
  };
}

export function rowToMinerHardware(r: Row): MinerHardwareRecord {
  return {
    accountId: String(r.account_id),
    nodeId: String(r.node_id),
    miners: json<Array<{ id: string; type: MinerCategory }>>(r.miners),
    primaryType: String(r.primary_type) as MinerCategory,
    source: String(r.source) as MinerHardwareRecord["source"],
    observedAt: iso(r.observed_at),
  };
}

export function rowToValidatorAuthorship(r: Row): {
  accountId: string;
  blocksAuthored: number;
  blocksAuthoredWithPow: number;
  lastAuthoredBlock: string;
  lastAuthoredAt: string;
} {
  return {
    accountId: String(r.account_id),
    blocksAuthored: num(r.blocks_authored),
    blocksAuthoredWithPow: num(r.blocks_authored_with_pow),
    lastAuthoredBlock: String(r.last_authored_block),
    lastAuthoredAt: iso(r.last_authored_at),
  };
}

export function rowToNodeDescriptor(r: Row): NodeDescriptorRecord {
  return {
    accountId: String(r.account_id),
    blockNumber: String(r.block_number),
    blockHash: String(r.block_hash),
    extrinsicIndex: num(r.extrinsic_index),
    blockTimestamp: num(r.block_timestamp),
    firstBlockTimestamp: num(r.first_block_timestamp),
    descriptor: json<NodeDescriptor>(r.descriptor),
    observedAt: iso(r.observed_at),
  };
}

export function rowToMiningSubmission(r: Row): MiningSubmissionRecord {
  return {
    minerId: String(r.miner_id),
    solutionNumber: num(r.solution_number),
    tsNs: String(r.ts_ns),
    energyMilli: num(r.energy_milli),
    diversityMilli: num(r.diversity_milli),
    thresholdMilli: num(r.threshold_milli),
    lastProofBlockHash: String(r.last_proof_block_hash),
    extrinsicHash: r.extrinsic_hash == null ? null : String(r.extrinsic_hash),
    chainBlockHash: r.chain_block_hash == null ? null : String(r.chain_block_hash),
    chainBlockNumber: r.chain_block_number == null ? null : String(r.chain_block_number),
    powSequence: r.pow_sequence == null ? null : num(r.pow_sequence),
    outcome: String(r.outcome),
    attemptCount: num(r.attempt_count),
    bestEnergyMilli: num(r.best_energy_milli),
    numValid: num(r.num_valid),
    minerType: r.miner_type == null ? "" : String(r.miner_type),
    qpuAccessTimeUs: r.qpu_access_time_us == null ? 0 : num(r.qpu_access_time_us),
    observedAt: iso(r.observed_at),
  };
}
