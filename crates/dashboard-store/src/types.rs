// SPDX-License-Identifier: AGPL-3.0-or-later
use dashboard_model::{
    BlockHash, BlockRecord, DecimalString as BlockHeight, DifficultyRecord,
    QBlockParticipationRecord,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Explicit database selection. Opening storage never performs network binding.
#[derive(Clone)]
pub enum StoreConfig {
    /// Local Turso engine; not libSQL.
    Turso {
        #[doc = "Local database file path."]
        path: PathBuf,
    },
    /// Existing or fresh Postgres database.
    Postgres {
        #[doc = "Postgres connection URL; never logged."]
        url: String,
        #[doc = "Maximum concurrent reader connections."]
        max_connections: u32,
    },
}
/// Persistence errors never imply a completed decode or empty chain range.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("API response capacity exceeded")]
    #[doc = "A public projection exceeds its bounded row or byte capacity."]
    Capacity,
    #[error("database: {0}")]
    #[doc = "Database engine failure."]
    Database(String),
    #[error("invalid store input: {0}")]
    #[doc = "Invalid input or persisted data."]
    Invalid(String),
    #[error("network is unbound or conflicts with retained history")]
    #[doc = "Network identity is unverified or conflicts."]
    NetworkIdentity,
    #[error("network verification unavailable: {0}")]
    #[doc = "The upstream could not supply retained history evidence for verification."]
    VerificationUnavailable(String),
    #[error("database already has a writer")]
    #[doc = "Another process owns the writer lease."]
    WriterOwned,
    #[error("store is read-only; mutations require the owning writer")]
    #[doc = "API-only storage rejects mutation operations."]
    ReadOnly,
    #[error("unsupported migration history: {0}")]
    #[doc = "The migration ledger is not a supported ordered prefix."]
    MigrationHistory(String),
    #[error("range enumeration is incomplete or contains uncommitted winners")]
    #[doc = "Enumeration or discovered winner persistence is incomplete."]
    IncompleteScan,
    #[error("conflicting finalized history at height {0}")]
    #[doc = "A finalized height already has a different hash."]
    ConflictingHistory(String),
    #[error(transparent)]
    #[doc = "Record or coverage JSON encoding failure."]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    #[doc = "Local storage or writer lock failure."]
    Io(#[from] std::io::Error),
}
impl From<turso::Error> for StoreError {
    fn from(e: turso::Error) -> Self {
        Self::Database(e.to_string())
    }
}
impl From<turso_core::LimboError> for StoreError {
    fn from(error: turso_core::LimboError) -> Self {
        Self::Database(error.to_string())
    }
}
#[cfg(feature = "postgres")]
impl From<sqlx::Error> for StoreError {
    fn from(e: sqlx::Error) -> Self {
        Self::Database(e.to_string())
    }
}
/// Mutation result at the serialized transaction boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommitResult {
    #[doc = "Applied."]
    Applied,
    #[doc = "All requested facts and completion effects already match."]
    AlreadyApplied,
    #[doc = "Reindex invalidated one or more generation guards."]
    StaleGeneration,
}
/// Independently reindexable data domains.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Indexable {
    #[doc = "Winners."]
    Winners,
    #[doc = "Difficulty."]
    Difficulty,
    #[doc = "Participation."]
    Participation,
    #[doc = "Authorship."]
    Authorship,
}
impl Indexable {
    /// Stable legacy meta-key suffix.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Winners => "winners",
            Self::Difficulty => "difficulty",
            Self::Participation => "participation",
            Self::Authorship => "authorship",
        }
    }
}
/// Generation observed before decoding one domain.
#[derive(Clone, Debug)]
pub struct GenerationGuard {
    #[doc = "Independent indexed domain."]
    pub indexable: Indexable,
    #[doc = "Generation observed before work began."]
    pub expected: u64,
}
/// A successful pinned read proved that required retained data is absent.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnavailableReason {
    /// A qualifying winner has no recoverable retained nonce.
    MissingRetainedNonce,
    /// A winner has no retained block difficulty.
    MissingRetainedDifficulty,
}
impl UnavailableReason {
    /// Stable database reason code.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::MissingRetainedNonce => "missing_retained_nonce",
            Self::MissingRetainedDifficulty => "missing_retained_difficulty",
        }
    }
}
/// Durable retry suppression. This never claims completed coverage.
#[derive(Clone, Debug)]
pub struct UnavailableBlock {
    /// Domain and generation observed before decoding.
    pub guard: GenerationGuard,
    /// Finalized block height.
    pub height: BlockHeight,
    /// Finalized block hash.
    pub hash: BlockHash,
    /// Immutable finalized state used for the successful enrichment read.
    pub enrichment_at: BlockHash,
    /// Required data that the successful read could not supply.
    pub reason: UnavailableReason,
}
/// One finalized author fact, separate from the public aggregate DTO.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuthorshipRecord {
    #[doc = "Validator account identifier."]
    pub account_id: String,
    #[doc = "Substrate block height."]
    pub block_number: BlockHeight,
    #[doc = "Block time in Unix seconds."]
    pub timestamp: u64,
    #[doc = "Whether this substrate block also had a `PoW` winner."]
    pub had_winner: bool,
}
/// Decoded records submitted atomically. Empty participation alone proves nothing.
#[derive(Clone, Debug, Default)]
pub struct BlockRecords {
    #[doc = "Optional decoded winner."]
    pub winner: Option<BlockRecord>,
    #[doc = "Optional winner-derived difficulty."]
    pub difficulty: Option<DifficultyRecord>,
    #[doc = "Optional validator authorship fact."]
    pub authorship: Option<AuthorshipRecord>,
    #[doc = "Successfully decoded participant records."]
    pub participation: Vec<QBlockParticipationRecord>,
}
/// Atomic data and coverage delta for one finalized block.
#[derive(Clone, Debug)]
pub struct BlockCommit {
    #[doc = "Verified chain genesis hash."]
    pub genesis: BlockHash,
    #[doc = "Finalized substrate block hash."]
    pub hash: BlockHash,
    #[doc = "Substrate block height."]
    pub height: BlockHeight,
    #[doc = "Expected generation for every affected domain."]
    pub guards: Vec<GenerationGuard>,
    #[doc = "Records written in this transaction."]
    pub records: BlockRecords,
    #[doc = "Domains successfully decoded, including proven empty results."]
    pub completed: Vec<Indexable>,
}
/// Stable enumeration identifier selected by the caller.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ScanId(pub String);
/// A bounded key enumeration pinned to one verified finalized state.
#[derive(Clone, Debug)]
pub struct Scan {
    #[doc = "Durable enumeration identifier."]
    pub id: ScanId,
    #[doc = "Verified chain genesis hash."]
    pub genesis: BlockHash,
    #[doc = "Pinned finalized state used for key enumeration."]
    pub at: BlockHash,
    #[doc = "Height of the pinned finalized state."]
    pub finalized_height: BlockHeight,
    #[doc = "Independent indexed domain."]
    pub indexable: Indexable,
    #[doc = "Generation observed before enumeration began."]
    pub expected_generation: u64,
}
/// Durable progress; `finished` means explicit key exhaustion, not an empty page.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScanProgress {
    #[doc = "Raw key continuation cursor."]
    pub cursor: Option<Vec<u8>>,
    #[doc = "True only after explicit enumeration exhaustion."]
    pub finished: bool,
}
/// Range completion requires a persisted exhausted scan and every winner committed.
#[derive(Clone, Debug)]
pub struct RangeCompletion {
    #[doc = "Verified chain genesis hash."]
    pub genesis: BlockHash,
    #[doc = "Independent indexed domain."]
    pub indexable: Indexable,
    #[doc = "Generation observed before enumeration began."]
    pub expected_generation: u64,
    #[doc = "Inclusive first height."]
    pub from: BlockHeight,
    #[doc = "Inclusive last height."]
    pub through: BlockHeight,
    #[doc = "Persisted exhausted enumeration that proves this range."]
    pub scan_id: ScanId,
}
/// Retained block identity to verify against upstream before binding old data.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RetainedBlock {
    #[doc = "Substrate block height."]
    pub height: BlockHeight,
    #[doc = "Finalized substrate block hash."]
    pub hash: BlockHash,
}
/// Historical Kysely ledger status, preserving original timestamps.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MigrationStatusRow {
    #[doc = "Historical migration name."]
    pub name: String,
    #[doc = "Original execution timestamp, when applied."]
    pub executed_at: Option<String>,
}
/// Legacy coverage wire shape. Heights are bounded u64 protocol numbers.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    #[doc = "Coverage format version, currently one."]
    pub v: u8,
    #[doc = "Current domain generation."]
    pub r#gen: u64,
    #[doc = "First eligible block height."]
    pub start: u64,
    #[doc = "Lowest completed height."]
    pub low: Option<u64>,
    #[doc = "Highest completed height."]
    pub high: Option<u64>,
    #[doc = "Sorted, disjoint uncovered intervals within the bounds."]
    pub gaps: Vec<[u64; 2]>,
    #[doc = "Highest unavailable height; this does not imply coverage."]
    pub pruned_floor: Option<u64>,
    #[doc = "Informational ISO 8601 update time."]
    pub updated_at: Option<String>,
}
/// Startup missing-device-time probe.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAccessTimeProbe {
    #[doc = "Whether any winner history is stored."]
    pub has_blocks: bool,
    #[doc = "Whether any winner reports device access time."]
    pub has_reported: bool,
}
/// Winner identity for topology enrichment.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingTopology {
    #[doc = "Winner solution hash."]
    pub block_hash: String,
    #[doc = "Substrate winner height as decimal text."]
    pub substrate_block_number: String,
}

impl std::fmt::Debug for StoreConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Turso { path } => f.debug_struct("Turso").field("path", path).finish(),
            Self::Postgres {
                max_connections, ..
            } => f
                .debug_struct("Postgres")
                .field("url", &"[redacted]")
                .field("max_connections", max_connections)
                .finish(),
        }
    }
}
