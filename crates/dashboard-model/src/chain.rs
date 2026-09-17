// SPDX-License-Identifier: AGPL-3.0-or-later

//! Chain-derived dashboard records.

use serde::{Deserialize, Serialize};

use crate::decimal::DecimalString;
use crate::hash::BlockHash;
use crate::miner::MinerHardwareRecord;

/// A `PoW` block as recorded by the dashboard.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockRecord {
    /// `PoW` solution hash and table primary key.
    pub block_hash: BlockHash,
    /// Substrate block height as decimal.
    pub substrate_block_number: DecimalString,
    /// Substrate block hash.
    pub substrate_block_hash: BlockHash,
    /// Substrate parent hash.
    pub substrate_parent_hash: BlockHash,
    /// Unix seconds of the block timestamp.
    pub timestamp: u64,
    /// Winner account id.
    pub miner_id: String,
    /// Proof energy.
    pub energy: f64,
    /// Proof diversity.
    pub diversity: f64,
    /// Validator-reported valid solution count.
    pub num_valid_solutions: u64,
    /// Seconds of compute behind the winning proof.
    pub mining_time: f64,
    /// Self-reported device compute microseconds, if present.
    pub device_access_time_us: Option<u64>,
    /// Reward amount as decimal.
    pub reward: DecimalString,
    /// Monotonic 1-based qblock id as decimal.
    pub qblock_id: DecimalString,
    /// Nonce as decimal.
    pub nonce: DecimalString,
    /// Topology node count.
    pub num_nodes: u32,
    /// Topology edge count.
    pub num_edges: u32,
    /// Difficulty energy at mine time.
    pub difficulty_energy: f64,
    /// Minimum diversity at mine time.
    pub min_diversity: f64,
    /// Minimum solutions at mine time.
    pub min_solutions: u32,
    /// Whether the substrate block is finalized.
    pub finalized: bool,
    /// Default topology hash at index time.
    pub topology_hash: Option<BlockHash>,
}

/// One node's declared participation in a qblock.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QBlockParticipationRecord {
    /// Qblock id as decimal.
    pub qblock_id: DecimalString,
    /// SS58 account id of the participant.
    pub account: String,
    /// Raw on-chain `MinerKind` variant name.
    pub kind: String,
    /// Declared compute-time budget in seconds.
    pub budget_seconds: Option<f64>,
    /// Substrate block number the participation was written at.
    pub block_number: DecimalString,
}

/// Runtime version snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeVersion {
    /// Spec name.
    pub spec_name: String,
    /// Spec version.
    pub spec_version: u32,
    /// Transaction version.
    pub transaction_version: u32,
    /// Implementation name.
    pub impl_name: String,
    /// Block number of the last runtime upgrade as decimal.
    pub last_runtime_upgrade: Option<DecimalString>,
}

/// Best and finalized substrate chain heads plus runtime version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainHead {
    /// Best block number as decimal.
    pub best_block_number: DecimalString,
    /// Best block hash.
    pub best_block_hash: BlockHash,
    /// Finalized block number as decimal.
    pub finalized_block_number: DecimalString,
    /// Finalized block hash.
    pub finalized_block_hash: BlockHash,
    /// `bestBlockNumber - finalizedBlockNumber`.
    pub finality_lag: i64,
    /// Network-wide winning qblock count.
    pub qblock_count: Option<u64>,
    /// In-flight qblock id as decimal.
    #[serde(rename = "currentQBlockId")]
    pub current_qblock_id: Option<DecimalString>,
    /// Participant count on the in-flight qblock.
    #[serde(rename = "currentQBlockParticipants")]
    pub current_qblock_participants: Option<u64>,
    /// Active runtime version.
    pub runtime: RuntimeVersion,
    /// ISO 8601 update time.
    pub updated_at: String,
}

/// Current per-topology difficulty for one mineable topology.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MineableTopologyRecord {
    /// Topology hash.
    pub topology_hash: BlockHash,
    /// True for the chain default topology.
    pub is_default: bool,
    /// Maximum energy.
    pub difficulty_energy: f64,
    /// Minimum diversity.
    pub min_diversity: f64,
    /// Minimum solutions.
    pub min_solutions: u32,
    /// Node count.
    pub node_count: u32,
    /// Edge count.
    pub edge_count: u32,
    /// Energy-curve constant K.
    pub curve_constant: Option<f64>,
}

/// Substrate BABE epoch state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BabeEpochState {
    /// Epoch index.
    pub epoch_index: u64,
    /// Current BABE slot as decimal.
    pub current_slot: DecimalString,
    /// Epoch start slot as decimal.
    pub epoch_start_slot: DecimalString,
    /// Slots per epoch.
    pub slots_per_epoch: u64,
    /// Slot offset within the epoch.
    pub current_slot_in_epoch: u64,
    /// Number of BABE authorities in this epoch.
    pub authority_count: u32,
}

/// Thin record for a BABE authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BabeAuthorityRecord {
    /// Authority account id.
    pub account_id: String,
    /// Optional identity display name.
    pub display_name: Option<String>,
}

/// On-chain miner state from `pallet-quantum-pow`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainMinerRecord {
    /// Miner account id.
    pub account_id: String,
    /// Locked deposit as decimal.
    pub deposit: DecimalString,
    /// Lifetime proofs submitted as decimal.
    pub proofs_submitted: DecimalString,
    /// Lifetime proofs won as decimal.
    pub proofs_won: DecimalString,
    /// Lifetime rewards as decimal.
    pub rewards_earned: DecimalString,
    /// Joined telemetry node address.
    pub telemetry_node_address: Option<String>,
    /// Joined hardware record.
    pub hardware: Option<MinerHardwareRecord>,
}

/// Writer of a difficulty snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DifficultySource {
    /// Derived from a winner block.
    Block,
    /// Live head snapshot.
    Poll,
}

/// Snapshot of difficulty at a substrate block.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DifficultyRecord {
    /// Substrate block number as decimal.
    pub observed_at_block: DecimalString,
    /// Maximum energy.
    pub difficulty_energy: f64,
    /// Minimum diversity.
    pub min_diversity: f64,
    /// Minimum solutions.
    pub min_solutions: u32,
    /// ISO 8601 observation time.
    pub observed_at: String,
    /// Default topology hash when this snapshot was taken.
    pub topology_hash: Option<BlockHash>,
    /// Which writer produced the row.
    pub source: DifficultySource,
}

/// Per-miner win aggregate over indexed blocks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinerWinsRow {
    /// Winner account id.
    pub miner_id: String,
    /// Indexed win count.
    pub wins: u64,
    /// Best (lowest) energy across stored wins.
    pub best_energy: f64,
    /// Mean mining time in seconds.
    pub avg_mining_time: f64,
    /// Unix seconds of the most recent stored win.
    pub last_won_at: u64,
}

/// Slim winner-block row for the mining-time chart.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiningHistoryRow {
    /// Qblock id as decimal.
    pub qblock_id: DecimalString,
    /// Substrate block number as decimal.
    pub substrate_block_number: DecimalString,
    /// Unix seconds of the winner block.
    pub timestamp: u64,
    /// Winner account id.
    pub miner_id: String,
    /// Seconds of compute behind the winning proof.
    pub mining_time: f64,
}

/// Per-validator authorship payload joined against the active BABE set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatorAuthorshipRecord {
    /// Validator account id.
    pub account_id: String,
    /// Authored block count.
    pub blocks_authored: u64,
    /// Authored blocks that also carried a `PoW` win.
    pub blocks_authored_with_pow: u64,
    /// Most recent authored block number as decimal.
    pub last_authored_block: Option<DecimalString>,
    /// ISO 8601 time of the most recent authored head.
    pub last_authored_at: Option<String>,
    /// True when `lastAuthoredAt` is within the freshness window.
    pub online: bool,
}
