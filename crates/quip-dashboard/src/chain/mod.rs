//! Read-only, snapshot-pinned chain access. No signing or node-service dependencies.
mod budget;
mod decode;
mod metadata;
mod snapshots;
mod transport;

pub use budget::PayloadMetrics;
pub use decode::{
    BabeDigest, BlockEvents, BlockWinnerEvent, DecodedExtrinsic, DifficultyInfo,
    ProofAcceptedEvent, QBlockInfo, RegistryChange, decode_events, decode_extrinsics,
};
pub use metadata::{BlockContexts, MetadataRecord, RuntimeContext, RuntimeVersionInfo};
pub use snapshots::{
    BabeEpochInfo, ChainMinerInfo, DescriptorEntry, MineableTopologyInfo, MinerPage,
    ParticipantCursor, ParticipantPage, QBlockParticipant, TopologySummary, WinnerCursor,
    WinnerPage,
};
pub use transport::{HeadReceivers, MethodMetrics, RpcMetrics, WorkClass};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Weak},
};
use tokio::sync::{Mutex, OnceCell, OwnedSemaphorePermit, Semaphore};

/// A full hash. Parsing rejects short, padded, and non-hex values.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BlockHash(pub [u8; 32]);
impl std::fmt::Display for BlockHash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "0x{}", hex::encode(self.0))
    }
}
impl std::str::FromStr for BlockHash {
    type Err = ChainError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let bytes = unhex(s)?;
        Ok(Self(bytes.try_into().map_err(|_| {
            ChainError::Invalid("hash must contain 32 bytes".into())
        })?))
    }
}
impl Serialize for BlockHash {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
impl<'de> Deserialize<'de> for BlockHash {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, thiserror::Error)]
/// Typed chain failures for retry, pruning, and capability decisions.
pub enum ChainError {
    #[error("RPC unavailable: {0}")]
    /// Transient connection, request, or server failure.
    Unavailable(String),
    #[error("historical state pruned: {0}")]
    /// The selected historical state is no longer available.
    Pruned(String),
    #[error("unsupported chain capability: {0}")]
    /// The runtime or endpoint does not expose the required capability.
    Unsupported(String),
    #[error("RPC response exceeds the 16 MiB limit: {0}")]
    /// A configured response or decoded collection limit was exceeded.
    Oversized(String),
    #[error("invalid chain data: {0}")]
    /// Malformed, inconsistent, or noncanonical chain data.
    Invalid(String),
    #[error("chain genesis mismatch: expected {expected}, got {actual}")]
    /// The endpoint belongs to another chain.
    GenesisMismatch {
        /// Genesis identity required by the selected database.
        expected: BlockHash,
        /// Genesis identity returned by the endpoint.
        actual: BlockHash,
    },
    #[error("chain reader capacity exhausted")]
    /// All bounded cache slots have active consumers.
    Busy,
    #[error("chain reader is disconnected")]
    /// The persistent transport is not connected.
    Disconnected,
    #[error("block not found: {0}")]
    /// The selected block header does not exist.
    NotFound(BlockHash),
}
impl From<subxt_core::Error> for ChainError {
    fn from(e: subxt_core::Error) -> Self {
        Self::Invalid(e.to_string())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
/// Substrate header as returned by JSON-RPC.
pub struct Header {
    /// Hash of the parent block.
    pub parent_hash: BlockHash,
    /// JSON-RPC uses hexadecimal block numbers. `height` checks the full u64 range.
    pub number: String,
    /// Root of this block's resulting storage state.
    pub state_root: BlockHash,
    /// Root of the extrinsics included in this block.
    pub extrinsics_root: BlockHash,
    /// Consensus digest logs.
    pub digest: Digest,
}
impl Header {
    /// Converts the RPC hexadecimal height to an exact u64.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub fn height(&self) -> Result<u64, ChainError> {
        let number = self
            .number
            .strip_prefix("0x")
            .ok_or_else(|| ChainError::Invalid("header number lacks 0x".into()))?;
        u64::from_str_radix(number, 16).map_err(|e| ChainError::Invalid(e.to_string()))
    }
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
/// SCALE consensus logs carried by a header.
pub struct Digest {
    /// Hex-encoded SCALE digest items.
    pub logs: Vec<String>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
/// Selects whether block decoding includes validator authorship.
pub enum BlockPurpose {
    /// Include timestamp, events, and BABE authorship.
    Full,
    /// Skip historical session and authorship reads.
    WinnerOnly,
}
#[derive(Debug)]
/// Shared finalized block and independent winner enrichment.
pub struct DecodedBlock {
    _payload_charge: Arc<budget::Charge>,
    active_payload: Option<(OwnedSemaphorePermit, Option<OwnedSemaphorePermit>)>,
    /// Hash of this finalized block.
    pub hash: BlockHash,
    /// JSON-RPC header for this block.
    pub header: Header,
    /// Execution and post-state metadata contexts.
    pub contexts: BlockContexts,
    /// Decoded events, timestamp, and optional authorship.
    pub events: BlockEvents,
    /// Retained winning solution, if enrichment succeeded.
    pub qblock: Option<QBlockInfo>,
    /// Enrichment failure that must remain uncovered and retryable.
    pub qblock_error: Option<ChainError>,
    /// Finalized snapshot used to read retained winning solutions.
    pub enrichment_at: BlockHash,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
/// Current node synchronization observations.
pub struct SyncStateInfo {
    /// Node major-sync flag after the genesis exception.
    pub is_syncing: bool,
    /// Connected peer count.
    pub peers: u64,
    /// Optional node-reported current height.
    pub current_block: Option<u64>,
    /// Optional node-reported highest known height.
    pub highest_block: Option<u64>,
}

type BlockKey = (BlockHash, BlockPurpose, BlockHash);
type BlockCell = Arc<OnceCell<Arc<DecodedBlock>>>;
type TopologyCache = BTreeMap<(BlockHash, BlockHash), Arc<OnceCell<TopologySummary>>>;

/// Clone the `Arc<ChainReader>` across consumers to share requests and budgets.
pub struct ChainReader {
    transport: transport::Transport,
    budget: Arc<budget::Budget>,
    genesis: BlockHash,
    metadata: Mutex<metadata::MetadataCache>,
    blocks: Mutex<BTreeMap<BlockKey, BlockCell>>,
    uncached_blocks: Mutex<BTreeMap<BlockKey, Weak<DecodedBlock>>>,
    block_jobs: Arc<Semaphore>,
    block_backfill: Arc<Semaphore>,
    topologies: Mutex<TopologyCache>,
}
impl ChainReader {
    /// Creates a disconnected reader for one endpoint and expected genesis.
    pub fn new(endpoint: impl Into<String>, expected_genesis: BlockHash) -> Self {
        let budget = Arc::new(budget::Budget::default());
        Self {
            transport: transport::Transport::new(endpoint.into(), budget.clone()),
            budget,
            genesis: expected_genesis,
            metadata: Mutex::new(metadata::MetadataCache::default()),
            blocks: Mutex::new(BTreeMap::new()),
            uncached_blocks: Mutex::new(BTreeMap::new()),
            block_jobs: Arc::new(Semaphore::new(4)),
            block_backfill: Arc::new(Semaphore::new(2)),
            topologies: Mutex::new(BTreeMap::new()),
        }
    }
    /// Discovers genesis using a temporary bounded connection.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn discover_genesis(endpoint: impl Into<String>) -> Result<BlockHash, ChainError> {
        let transport = transport::Transport::new(endpoint.into(), Arc::default());
        transport.connect().await?;
        let result = transport
            .request("chain_getBlockHash", json!([0]), WorkClass::Live)
            .await;
        transport.disconnect().await;
        serde_json::from_value(result?).map_err(invalid)
    }
    /// Connects the persistent transport and verifies its genesis.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn connect(&self) -> Result<(), ChainError> {
        self.transport.connect().await?;
        let actual = self.block_hash(0, WorkClass::Live).await?;
        if actual != Some(self.genesis) {
            self.transport.disconnect().await;
            return Err(ChainError::GenesisMismatch {
                expected: self.genesis,
                actual: actual.unwrap_or(BlockHash([0; 32])),
            });
        }
        Ok(())
    }
    /// Closes subscriptions and the persistent connection.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn disconnect(&self) -> Result<(), ChainError> {
        self.transport.disconnect().await;
        Ok(())
    }
    /// Returns retained payload charges, including outstanding consumer references.
    pub fn payload_metrics(&self) -> PayloadMetrics {
        self.budget.metrics()
    }
    /// Returns the configured chain identity.
    pub fn genesis(&self) -> BlockHash {
        self.genesis
    }
    /// Shares one best-head and one finalized-head subscription.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn subscribe_heads(&self) -> Result<HeadReceivers, ChainError> {
        self.transport.subscribe_heads().await
    }
    /// Returns cumulative RPC and cache counters.
    pub async fn metrics(&self) -> RpcMetrics {
        self.transport.metrics().await
    }
    /// Resolves a height without reducing integer precision.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn block_hash(
        &self,
        height: u64,
        class: WorkClass,
    ) -> Result<Option<BlockHash>, ChainError> {
        // String avoids JavaScript-style loss in RPC proxies for large integers.
        let value = self
            .transport
            .request(
                "chain_getBlockHash",
                json!([format!("0x{height:x}")]),
                class,
            )
            .await?;
        serde_json::from_value(value).map_err(invalid)
    }
    /// Reads a header using the shared immutable response cache.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn header(&self, hash: BlockHash, class: WorkClass) -> Result<Header, ChainError> {
        let value = self
            .transport
            .shared("chain_getHeader", json!([hash]), class)
            .await?;
        serde_json::from_value::<Option<Header>>(value.as_ref().as_ref().clone())
            .map_err(invalid)?
            .ok_or(ChainError::NotFound(hash))
    }
    /// Reads the current finalized head directly from the node.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn finalized_head(&self) -> Result<BlockHash, ChainError> {
        serde_json::from_value(
            self.transport
                .request("chain_getFinalizedHead", json!([]), WorkClass::Live)
                .await?,
        )
        .map_err(invalid)
    }
    /// Reads health and optional node synchronization heights.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn sync_state(&self) -> Result<SyncStateInfo, ChainError> {
        let health = self
            .transport
            .request("system_health", json!([]), WorkClass::Live)
            .await?;
        let mut state: SyncStateInfo = serde_json::from_value(health).map_err(invalid)?;
        match self
            .transport
            .request("system_syncState", json!([]), WorkClass::Live)
            .await
        {
            Ok(value) => {
                state.current_block = value.get("currentBlock").and_then(Value::as_u64);
                state.highest_block = value.get("highestBlock").and_then(Value::as_u64);
            }
            Err(ChainError::Unsupported(_)) => {}
            Err(error) => return Err(error),
        }
        // Match the existing sync gate's genesis exception.
        if state.highest_block == Some(0) {
            state.is_syncing = false;
        }
        Ok(state)
    }
    /// Decodes a block with its own state as the enrichment snapshot.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn finalized_block(&self, hash: BlockHash) -> Result<Arc<DecodedBlock>, ChainError> {
        self.block(hash, BlockPurpose::Full, hash, WorkClass::Live)
            .await
    }
    /// `enrichment_at` can be a newer finalized snapshot containing retained, migrated `QBlocks`.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn block(
        &self,
        hash: BlockHash,
        purpose: BlockPurpose,
        enrichment_at: BlockHash,
        class: WorkClass,
    ) -> Result<Arc<DecodedBlock>, ChainError> {
        let key = (hash, purpose, enrichment_at);
        let cell = {
            let mut cache = self.blocks.lock().await;
            let mut uncached = self.uncached_blocks.lock().await;
            uncached.retain(|_, value| value.strong_count() > 0);
            if let Some(block) = uncached.get(&key).and_then(Weak::upgrade) {
                return Ok(block);
            }
            let limit = 64 - uncached.len();
            if !cache.contains_key(&key) {
                make_room(&mut cache, limit, |c| Arc::strong_count(c) == 1)?;
            }
            cache.entry(key).or_default().clone()
        };
        let result = cell
            .get_or_try_init(|| self.load_block(hash, purpose, enrichment_at, class))
            .await
            .cloned();
        if let Ok(block) = &result
            && block.active_payload.is_some()
            && block.qblock_error.is_none()
            && (block.events.winner.is_none() || block.qblock.is_some())
        {
            let mut cache = self.blocks.lock().await;
            if cache
                .get(&key)
                .is_some_and(|entry| Arc::ptr_eq(entry, &cell))
            {
                let _ = cache.remove(&key);
                let _ = self
                    .uncached_blocks
                    .lock()
                    .await
                    .insert(key, Arc::downgrade(block));
            }
        }
        // Durable indexer markers suppress automatic retries. Do not retain absence
        // here: an explicit reindex must perform a new pinned enrichment read.
        if result.as_ref().is_ok_and(|block| {
            block.qblock_error.is_some()
                || (block.events.winner.is_some() && block.qblock.is_none())
        }) {
            let mut cache = self.blocks.lock().await;
            if cache
                .get(&key)
                .is_some_and(|entry| Arc::ptr_eq(entry, &cell))
            {
                let _ = cache.remove(&key);
            }
        }
        result
    }
    async fn load_block(
        &self,
        hash: BlockHash,
        purpose: BlockPurpose,
        enrichment_at: BlockHash,
        class: WorkClass,
    ) -> Result<Arc<DecodedBlock>, ChainError> {
        let backfill = match class {
            WorkClass::Live => None,
            WorkClass::Backfill => Some(
                self.block_backfill
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(invalid)?,
            ),
        };
        let active = self
            .block_jobs
            .clone()
            .acquire_owned()
            .await
            .map_err(invalid)?;
        let header = self.header(hash, class).await?;
        let contexts = self.contexts(hash, &header, class).await?;
        // Events are stored in B's post-state but encoded by its execution runtime.
        let event_bytes = self
            .raw_storage(hash, &contexts.execution, "System", "Events", vec![], class)
            .await?;
        let mut events = decode_events(&event_bytes, &contexts.execution.metadata)?;
        let timestamp = self
            .storage(hash, "Timestamp", "Now", vec![], class)
            .await?;
        events.timestamp = decode::unsigned(&timestamp)? / 1000;
        events.block_number = header.height()?;
        if purpose == BlockPurpose::Full {
            events.author = self.author(hash, &header, class).await?;
        }
        let (qblock, qblock_error) = if events.winner.is_some() {
            match self
                .winning_solution(enrichment_at, events.block_number, class)
                .await
            {
                Ok(qblock) => (qblock, None),
                Err(error) => (None, Some(error)),
            }
        } else {
            (None, None)
        };
        events.nonce = qblock.as_ref().map(|q| q.nonce.clone());
        let bytes = block_payload_bytes(&header, &events, qblock.as_ref());
        if bytes > 16 * 1024 * 1024 {
            return Err(ChainError::Oversized(
                "decoded block payload exceeds 16 MiB".into(),
            ));
        }
        let uncached = bytes > budget::Kind::Block.limit();
        let payload_charge = if uncached {
            Arc::new(
                self.budget
                    .reserve(budget::Kind::ActiveBlock, bytes)
                    .ok_or(ChainError::Busy)?,
            )
        } else {
            let mut cache = self.blocks.lock().await;
            loop {
                if let Some(charge) = self.budget.reserve(budget::Kind::Block, bytes) {
                    break Arc::new(charge);
                }
                let removable = cache
                    .iter()
                    .find(|(_, value)| Arc::strong_count(value) == 1)
                    .map(|(key, _)| *key)
                    .ok_or(ChainError::Busy)?;
                let _ = cache.remove(&removable);
            }
        };
        Ok(Arc::new(DecodedBlock {
            _payload_charge: payload_charge,
            active_payload: if uncached {
                Some((active, backfill))
            } else {
                None
            },
            hash,
            header,
            contexts,
            events,
            qblock,
            qblock_error,
            enrichment_at,
        }))
    }
    /// Reads retained winning data at a pinned snapshot, independent of historical state.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn winning_solution(
        &self,
        at: BlockHash,
        height: u64,
        class: WorkClass,
    ) -> Result<Option<QBlockInfo>, ChainError> {
        let value = self
            .runtime_call(
                at,
                "QuantumPowApi",
                "winning_solution",
                vec![scale_value::Value::u128(u128::from(height))],
                class,
            )
            .await?;
        decode::qblock(&value)
    }
    /// Reads the block timestamp in whole Unix seconds.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn timestamp(&self, at: BlockHash, class: WorkClass) -> Result<u64, ChainError> {
        decode::unsigned(&self.storage(at, "Timestamp", "Now", vec![], class).await?)
            .map(|ms| ms / 1000)
    }
    /// Reads the last proof height at the selected state.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn last_proof_block(
        &self,
        at: BlockHash,
        class: WorkClass,
    ) -> Result<u64, ChainError> {
        decode::unsigned(
            &self
                .storage(at, "QuantumPow", "LastProofBlock", vec![], class)
                .await?,
        )
    }
    /// Reads the exact network-wide winning solution count.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn qblock_count(&self, at: BlockHash, class: WorkClass) -> Result<u64, ChainError> {
        decode::unsigned(
            &self
                .storage(at, "QuantumPow", "QBlockCount", vec![], class)
                .await?,
        )
    }
    /// Returns the installed specification version as an upgrade sentinel.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn last_runtime_upgrade(
        &self,
        at: BlockHash,
        class: WorkClass,
    ) -> Result<Option<u32>, ChainError> {
        self.optional_storage(at, "System", "LastRuntimeUpgrade", vec![], class)
            .await?
            .as_ref()
            .map(|v| decode::u32_field(v, "spec_version"))
            .transpose()
    }
}
fn invalid(error: impl std::fmt::Display) -> ChainError {
    ChainError::Invalid(error.to_string())
}
fn unhex(s: &str) -> Result<Vec<u8>, ChainError> {
    hex::decode(
        s.strip_prefix("0x")
            .ok_or_else(|| ChainError::Invalid("hex value lacks 0x".into()))?,
    )
    .map_err(invalid)
}
fn make_room<K: Ord + Clone, V>(
    map: &mut BTreeMap<K, V>,
    limit: usize,
    removable: impl Fn(&V) -> bool,
) -> Result<(), ChainError> {
    if map.len() >= limit {
        let key = map
            .iter()
            .find(|(_, v)| removable(v))
            .map(|(k, _)| k.clone())
            .ok_or(ChainError::Busy)?;
        let _ = map.remove(&key);
    }
    Ok(())
}

fn block_payload_bytes(
    header: &Header,
    events: &BlockEvents,
    qblock: Option<&QBlockInfo>,
) -> usize {
    let mut bytes = size_of::<DecodedBlock>() + header.number.capacity();
    bytes += header.digest.logs.capacity() * size_of::<String>();
    bytes += header
        .digest
        .logs
        .iter()
        .map(String::capacity)
        .sum::<usize>();
    bytes += events.author.as_ref().map_or(0, String::capacity)
        + events.nonce.as_ref().map_or(0, String::capacity);
    bytes += events.proofs.capacity() * size_of::<ProofAcceptedEvent>();
    bytes += events
        .proofs
        .iter()
        .map(|proof| proof.miner.capacity())
        .sum::<usize>();
    bytes += events.changes.capacity() * size_of::<(String, String)>();
    bytes += events
        .changes
        .iter()
        .map(|(pallet, name)| pallet.capacity() + name.capacity())
        .sum::<usize>();
    bytes += events.registry_changes.capacity() * size_of::<RegistryChange>();
    bytes += events
        .registry_changes
        .iter()
        .map(|event| event.event.capacity())
        .sum::<usize>();
    bytes += events.miner_changes.capacity() * size_of::<[u8; 32]>();
    if let Some(winner) = &events.winner {
        bytes += winner.miner.capacity() + winner.reward.capacity();
    }
    if let Some(winner) = qblock {
        bytes += winner.miner.capacity() + winner.reward.capacity() + winner.nonce.capacity();
    }
    bytes
}
