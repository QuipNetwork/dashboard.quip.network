// SPDX-License-Identifier: AGPL-3.0-or-later

//! Public HTTP response types.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::chain::{
    BabeAuthorityRecord, BabeEpochState, BlockRecord, ChainHead, ChainMinerRecord,
    DifficultyRecord, MineableTopologyRecord, MinerWinsRow, MiningHistoryRow,
    ValidatorAuthorshipRecord,
};
use crate::decimal::DecimalString;
use crate::miner::{CurrentDispatch, MinerStats, MiningSubmissionRecord, ModeBreakdownMap};
use crate::serde_util::double_option;

/// QPU wall-clock to chip-access ratio used when exact telemetry is absent.
pub const QPU_ACCESS_TO_WALL_RATIO: f64 = 74.89;

/// One-shot device-access-time backfill decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeviceAccessTimeBackfill {
    /// A winners reindex was auto-scheduled.
    Triggered,
    /// Reported values already existed, or the database was fresh.
    NotNeeded,
}

/// Per-plugin coverage summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexerPluginCoverage {
    /// Lowest covered block as decimal.
    pub low: Option<DecimalString>,
    /// Highest covered block as decimal.
    pub high: Option<DecimalString>,
    /// Failed or pending-retry block count.
    pub gap_blocks: u64,
    /// Pruned floor as decimal.
    pub pruned_floor: Option<DecimalString>,
    /// Topology enrichment floor as decimal.
    pub topology_enrichment_floor: Option<DecimalString>,
    /// Coverage generation.
    pub generation: u64,
}

/// Spec §11: per-plugin coverage summary surfaced through `/api/telemetry`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexerBackfillProgress {
    /// Scheduler queue depth.
    pub backfill_queue_depth: u64,
    /// Coverage keyed by plugin name.
    pub coverage: BTreeMap<String, IndexerPluginCoverage>,
    /// First block with own difficulty as decimal.
    pub difficulty_data_start_block: Option<DecimalString>,
    /// Server-computed seconds until backfill catch-up.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub backfill_eta_seconds: Option<Option<f64>>,
}

/// Observability snapshot written by the indexer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexerObservability {
    /// Best block height the locally polled miner reported, as decimal.
    pub chain_head_from_node: Option<DecimalString>,
    /// ISO 8601 last `/api/v1/status` poll.
    pub last_status_fetch_at: String,
    /// ISO 8601 last block insert.
    pub last_block_insert_at: Option<String>,
    /// ISO 8601 last substrate head event.
    pub last_substrate_event_at: Option<String>,
    /// Best substrate height as decimal.
    pub best_block_height: Option<DecimalString>,
    /// Finalized substrate height as decimal.
    pub finalized_block_height: Option<DecimalString>,
    /// Live WSS socket state.
    pub chain_connected: bool,
    /// Sync-gate flag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_syncing: Option<bool>,
    /// Validator-reported sync current block as decimal.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub node_sync_current_block: Option<Option<DecimalString>>,
    /// Validator-reported sync highest block as decimal.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub node_sync_highest_block: Option<Option<DecimalString>>,
    /// True after a live status probe confirmed the local miner SS58.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub self_identified: Option<bool>,
    /// Latest miner stats.
    pub miner_stats: Option<MinerStats>,
    /// Per-backend breakdown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<ModeBreakdownMap>,
    /// Pipeline backfill progress.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indexer: Option<IndexerBackfillProgress>,
    /// Device-access-time backfill decision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_access_time_backfill: Option<DeviceAccessTimeBackfill>,
}

/// `GET /api/difficulty-history` body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DifficultyHistoryResponse {
    /// ISO 8601 cutoff echoed from the query.
    pub since: String,
    /// Newest snapshot strictly before the cutoff.
    pub anchor: Option<DifficultyRecord>,
    /// In-window rows ascending by `observedAt`.
    pub rows: Vec<DifficultyRecord>,
}

/// `GET /api/miner-wins` body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MinerWinsResponse {
    /// Per-miner win aggregates, wins descending.
    pub rows: Vec<MinerWinsRow>,
}

/// `GET /api/node/{account}/summary` body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSummaryResponse {
    /// The account's stored win summary, absent before its first win.
    pub summary: Option<MinerWinsRow>,
    /// Winner block of the account's last won qblock.
    pub last_won_block: Option<BlockRecord>,
}

/// `GET /api/mining-history` body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MiningHistoryResponse {
    /// ISO 8601 cutoff echoed from the query.
    pub since: String,
    /// Slim winner rows at or after the cutoff.
    pub rows: Vec<MiningHistoryRow>,
}

/// Joined participation fact for per-type compute aggregates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParticipationComputeRow {
    /// Qblock id as decimal.
    pub qblock_id: DecimalString,
    /// Participant account id.
    pub account: String,
    /// Raw on-chain miner kind.
    pub kind: String,
    /// Block-active wall clock in seconds.
    pub mining_seconds: f64,
    /// Exact QPU access microseconds from miner telemetry.
    pub exact_qpu_access_us: Option<u64>,
}

/// On-demand live snapshot for a peer node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeLiveData {
    /// Requested account id.
    pub account_id: String,
    /// False when the peer REST host could not be reached.
    pub reachable: bool,
    /// Latest miner stats.
    pub miner_stats: Option<MinerStats>,
    /// Per-backend breakdown. Empty for single-process miners.
    pub modes: ModeBreakdownMap,
    /// In-flight or just-completed dispatch.
    pub current_dispatch: Option<CurrentDispatch>,
    /// ISO 8601 time the server stamped this snapshot.
    pub fetched_at: String,
}

/// Pointer to file-backed time-series data the client downloads directly.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryFiles {
    /// Absolute static URL of the qblock manifest (`/files/qblocks/metadata.json`).
    pub qblocks_manifest: String,
    /// Absolute static URL of the nodes document (`/files/nodes/snapshot.json`).
    pub nodes_snapshot: String,
    /// Absolute static URL of the local miner's current dispatch document,
    /// or `None` when no self address is known.
    pub miner_current_dispatch: Option<String>,
}

/// What this deployment can serve. A field is `false` when the deployment
/// will never produce that data, which the client shows differently from
/// data that has simply not arrived yet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Whether a miner poller runs here. False in API-only mode, where no
    /// process contacts a miner, so `files.minerCurrentDispatch` never
    /// resolves.
    pub miner_dispatch: bool,
}

/// `GET /api/telemetry` body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryResponse {
    /// SS58 of the locally polled miner.
    pub self_address: Option<String>,
    /// Indexer observability.
    pub indexer: Option<IndexerObservability>,
    /// ISO 8601 server time.
    pub server_time: String,
    /// Substrate chain head.
    pub chain_head: Option<ChainHead>,
    /// Current BABE epoch.
    pub babe_epoch: Option<BabeEpochState>,
    /// Active BABE authorities.
    pub babe_authorities: Vec<BabeAuthorityRecord>,
    /// On-chain miners.
    pub chain_miners: Vec<ChainMinerRecord>,
    /// Recent difficulty snapshots, most recent first.
    pub recent_difficulty: Vec<DifficultyRecord>,
    /// Current mineable topologies.
    pub mineable_topologies: Vec<MineableTopologyRecord>,
    /// Authorship joined against the active BABE set.
    pub validators: Vec<ValidatorAuthorshipRecord>,
    /// Recent submissions by the locally polled miner.
    pub recent_mining_submissions: Vec<MiningSubmissionRecord>,
    /// Lifetime problems attempted by self.
    pub self_problems_attempted: u64,
    /// Pointer to file-backed time-series data.
    pub files: TelemetryFiles,
    /// What this deployment can serve.
    pub capabilities: Capabilities,
}

/// Error body returned by the HTTP API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorResponse {
    /// Error message.
    pub error: String,
    /// Optional detail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}
