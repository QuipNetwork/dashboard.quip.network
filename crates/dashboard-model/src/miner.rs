// SPDX-License-Identifier: AGPL-3.0-or-later

//! Miner telemetry records.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::decimal::DecimalString;
use crate::hash::BlockHash;

/// Dashboard miner category derived from on-chain miner kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum MinerCategory {
    /// CPU miner.
    Cpu,
    /// GPU miner.
    Gpu,
    /// QPU miner.
    Qpu,
    /// Any other miner kind.
    Other,
}

/// Provenance of a hardware inventory row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum MinerHardwareSource {
    /// Locally polled miner.
    #[serde(rename = "self")]
    SelfAccount,
    /// Peer REST query.
    #[serde(rename = "peer-query")]
    PeerQuery,
    /// Chain-published hardware metadata.
    #[serde(rename = "chain")]
    Chain,
}

/// One miner handle in a hardware inventory or mode breakdown.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MinerHandle {
    /// Miner identifier.
    pub id: String,
    /// Miner category.
    #[serde(rename = "type")]
    pub miner_type: MinerCategory,
}

/// Per-miner hardware inventory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinerHardwareRecord {
    /// SS58 account id.
    pub account_id: String,
    /// Node identifier from the miner.
    pub node_id: String,
    /// Worker handles on this node.
    pub miners: Vec<MinerHandle>,
    /// Dominant type across `miners`.
    pub primary_type: MinerCategory,
    /// How this row was observed.
    pub source: MinerHardwareSource,
    /// ISO 8601 observation time.
    pub observed_at: String,
}

/// Aggregate counters from `/api/v1/stats`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinerStats {
    /// Heads observed by the controller.
    pub heads_observed: u64,
    /// Contexts dispatched to workers.
    pub contexts_dispatched: u64,
    /// Dispatches that produced a result.
    pub results_received: u64,
    /// Proofs submitted to the chain.
    pub proofs_submitted: u64,
    /// Stale drops.
    pub stale_drops: u64,
    /// Submission errors.
    pub submission_errors: u64,
    /// Duplicate-result drops.
    pub duplicate_result_drops: u64,
}

/// Per-backend slice of a multi-process miner snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeBreakdown {
    /// Heads observed in this mode.
    pub heads_observed: u64,
    /// Contexts dispatched in this mode.
    pub contexts_dispatched: u64,
    /// Results received in this mode.
    pub results_received: u64,
    /// Proofs submitted in this mode.
    pub proofs_submitted: u64,
    /// Stale drops in this mode.
    pub stale_drops: u64,
    /// Submission errors in this mode.
    pub submission_errors: u64,
    /// Duplicate-result drops in this mode.
    pub duplicate_result_drops: u64,
    /// Worker handles owned by this mode.
    pub miners: Vec<MinerHandle>,
}

/// Per-submission summary from the miner attempts endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiningSubmissionRecord {
    /// Global chain solution number.
    pub solution_number: u64,
    /// Miner account id.
    pub miner_id: String,
    /// Backend that produced this submission.
    pub miner_type: String,
    /// Submission wall-clock, nanoseconds as decimal.
    pub ts_ns: DecimalString,
    /// Energy in milli units.
    pub energy_milli: i64,
    /// Diversity in milli units.
    pub diversity_milli: i64,
    /// Decayed difficulty targeted at submit time, milli units.
    pub threshold_milli: i64,
    /// Last proof block hash.
    ///
    /// Exists as a plain string, not a validated 32-byte [`BlockHash`], because
    /// existing miners emit a `0x0` sentinel (or the empty string) for rows
    /// without a landed proof. The value is preserved verbatim from telemetry.
    pub last_proof_block_hash: String,
    /// Extrinsic hash, if landed.
    pub extrinsic_hash: Option<BlockHash>,
    /// Chain block hash, if landed.
    pub chain_block_hash: Option<BlockHash>,
    /// Chain block number as decimal, if landed.
    pub chain_block_number: Option<DecimalString>,
    /// On-chain proofs-submitted sequence for non-winners.
    pub pow_sequence: Option<u64>,
    /// Outcome string preserved from the miner.
    pub outcome: String,
    /// Number of attempts in the envelope.
    pub attempt_count: u32,
    /// Best energy milli across attempts.
    pub best_energy_milli: i64,
    /// Valid-solution count at submit time.
    pub num_valid: u64,
    /// Sum of QPU access time across iterations, microseconds.
    pub qpu_access_time_us: u64,
    /// ISO 8601 time the indexer fetched this submission.
    pub observed_at: String,
    /// True for UI-synthesized chain-only rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain_only: Option<bool>,
}

/// Per-iteration row inside a mining submission.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiningAttempt {
    /// Iteration index.
    pub iter: u32,
    /// Best energy milli for this iteration.
    pub best_energy_milli: i64,
    /// Result kind preserved from the miner.
    pub result_kind: String,
    /// Backend that produced this iteration.
    pub miner_type: String,
    /// Additional miner fields.
    pub extra: serde_json::Value,
}

/// Envelope returned by `/api/mining/attempts/:solutionNumber`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MiningAttemptsResponse {
    /// Submission summary.
    pub submission: MiningSubmissionRecord,
    /// Iteration trail.
    pub attempts: Vec<MiningAttempt>,
}

/// In-flight or just-completed dispatch for the current global problem.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentDispatch {
    /// Global solution number being ground.
    pub solution_number: u64,
    /// Iteration trail.
    pub attempts: Vec<MiningAttempt>,
    /// Dispatch status.
    pub status: DispatchStatus,
}

/// Status of [`CurrentDispatch`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DispatchStatus {
    /// The miner is grinding this solution.
    InFlight,
    /// The miner just finished this solution.
    Completed,
}

/// Per-backend breakdown map keyed by mode name (`cpu`, `gpu`, `qpu`).
pub type ModeBreakdownMap = BTreeMap<String, ModeBreakdown>;
