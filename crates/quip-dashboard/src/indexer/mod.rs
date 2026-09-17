// SPDX-License-Identifier: AGPL-3.0-or-later
//! Finalized indexing with two workers, owned admission, and durable domain coverage.
pub mod admission;
mod backfill;
pub mod coverage;
pub mod file_writer;
mod live;
mod reconcile;
pub mod sync_gate;

use crate::chain::{BlockHash, ChainError, ChainReader, WorkClass};
use admission::Admission;
use dashboard_model::{BlockHash as ModelHash, DecimalString};
use dashboard_store::{CommitResult, GenerationGuard, Indexable, RetainedBlock, Store, StoreError};
use std::{sync::Arc, time::Duration};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

const DOMAINS: [Indexable; 4] = [
    Indexable::Winners,
    Indexable::Difficulty,
    Indexable::Participation,
    Indexable::Authorship,
];
const SPARSE: [Indexable; 3] = [
    Indexable::Winners,
    Indexable::Difficulty,
    Indexable::Participation,
];
const PAGE_SIZE: u32 = 256;

/// Observable committed progress. An announced head never counts as a committed head.
#[derive(Clone, Debug, Default)]
pub struct Progress {
    /// Latest best height for display only.
    pub best_height: Option<u64>,
    /// Highest received finalized height, observable even while its durable write is pending.
    pub finalized_height: Option<u64>,
    /// Last successfully committed finalized height this process has observed.
    pub committed_height: Option<u64>,
    /// Number of owned block slots.
    pub admitted: usize,
    /// Last error; cleared only by a successful block commit.
    pub last_error: Option<String>,
    /// Whether finalized subscriptions are attached.
    pub connected: bool,
}
/// Indexer failures preserve uncovered work for the next connection.
#[derive(Debug, thiserror::Error)]
pub enum IndexerError {
    /// Upstream transport, decoding, or pruning error.
    #[error(transparent)]
    Chain(#[from] ChainError),
    /// Serialized persistence failure.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// Record values or scheduling state violate the contract.
    #[error("indexer data: {0}")]
    Invalid(String),
    /// The requested generation was replaced during decoding.
    #[error("indexer generation changed")]
    StaleGeneration,
}
/// Runtime assembly supplies one shared chain reader and an already network-bound store.
pub struct Indexer {
    store: Arc<Store>,
    chain: Arc<ChainReader>,
    admission: Admission,
    registry: tokio::sync::Mutex<()>,
    live_work: tokio::sync::Mutex<()>,
    backfill_work: tokio::sync::Mutex<()>,
    sync_gate: tokio::sync::Mutex<sync_gate::SyncGate>,
    progress: watch::Sender<Progress>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Target {
    height: u64,
    hash: BlockHash,
}
impl Indexer {
    /// Create indexing and its coalesced progress channel.
    #[must_use]
    pub fn new(store: Arc<Store>, chain: Arc<ChainReader>) -> (Self, watch::Receiver<Progress>) {
        let (progress, receiver) = watch::channel(Progress::default());
        (
            Self {
                store,
                chain,
                admission: Admission::default(),
                registry: tokio::sync::Mutex::new(()),
                live_work: tokio::sync::Mutex::new(()),
                backfill_work: tokio::sync::Mutex::new(()),
                sync_gate: tokio::sync::Mutex::new(sync_gate::SyncGate::default()),
                progress,
            },
            receiver,
        )
    }
    /// Replay one finalized block using a pinned finalized enrichment snapshot.
    /// Runtime commands can use this after connecting and binding the shared store.
    /// # Errors
    /// Returns decode, finality, generation, or persistence failures without covering failed domains.
    pub async fn index_finalized(
        &self,
        height: u64,
        enrichment_at: BlockHash,
    ) -> Result<(), IndexerError> {
        let finalized = self.chain.finalized_head().await?;
        let finalized_height = self
            .chain
            .header(finalized, WorkClass::Live)
            .await?
            .height()?;
        let snapshot_height = self
            .chain
            .header(enrichment_at, WorkClass::Live)
            .await?
            .height()?;
        if height > snapshot_height
            || snapshot_height > finalized_height
            || self
                .chain
                .block_hash(snapshot_height, WorkClass::Live)
                .await?
                != Some(enrichment_at)
        {
            return Err(IndexerError::Invalid(
                "replay requires a canonical finalized snapshot".into(),
            ));
        }
        let permit = self
            .admission
            .try_live()
            .map_err(|e| IndexerError::Invalid(e.to_string()))?;
        self.progress
            .send_modify(|progress| progress.admitted = self.admission.active());
        let result = self
            .process(
                height,
                Target {
                    height: snapshot_height,
                    hash: enrichment_at,
                },
                WorkClass::Live,
            )
            .await;
        drop(permit);
        self.progress
            .send_modify(|progress| progress.admitted = self.admission.active());
        result
    }
    /// Run until cancellation. Transport failures reconnect with bounded backoff.
    /// The store must already be bound to `chain.genesis()` by runtime assembly.
    /// # Errors
    /// Returns conflicting finalized history or invalid persisted state; these cannot be retried safely.
    pub async fn run(&self, cancellation: CancellationToken) -> Result<(), IndexerError> {
        let mut delay = Duration::from_secs(1);
        loop {
            let result = tokio::select! {()=cancellation.cancelled()=>None,result=self.connection()=>Some(result)};
            self.progress.send_modify(|p| {
                p.connected = false;
                p.admitted = self.admission.active();
            });
            self.chain.disconnect().await?;
            let Some(result) = result else {
                return Ok(());
            };
            if let Err(error) = result {
                if fatal(&error) {
                    return Err(error);
                }
                self.error(&error);
            }
            tokio::select! {()=cancellation.cancelled()=>return Ok(()),()=tokio::time::sleep(delay)=>{}}
            delay = (delay * 2).min(Duration::from_secs(30));
        }
    }
    async fn connection(&self) -> Result<(), IndexerError> {
        self.chain.connect().await?;
        let mut heads = self.chain.subscribe_heads().await?;
        let hash = self.chain.finalized_head().await?;
        let height = self.chain.header(hash, WorkClass::Live).await?.height()?;
        let first = Target { height, hash };
        self.initialize(first).await?;
        let (targets, receiver) = watch::channel(first);
        self.progress.send_modify(|p| p.connected = true);
        let announce = async {
            loop {
                tokio::select! {
                    result=heads.best.changed()=>{
                        result.map_err(|_|ChainError::Disconnected)?;
                        let update=heads.best.borrow_and_update().clone();
                        if let Some(update)=update {let header=update?;let n=header.height()?;self.progress.send_modify(|p|p.best_height=Some(n));}
                    }
                    result=heads.finalized.changed()=>{
                        result.map_err(|_|ChainError::Disconnected)?;
                        let update=heads.finalized.borrow_and_update().clone();
                        if let Some(update)=update {
                            let header=update?;let height=header.height()?;
                            let hash=self.chain.block_hash(height,WorkClass::Live).await?.ok_or_else(||IndexerError::Invalid("announced finalized hash missing".into()))?;
                            self.observe(Target{height,hash}).await?;
                            if height>=targets.borrow().height {let _ = targets.send_replace(Target{height,hash});}
                        }
                    }
                }
            }
            #[expect(
                unreachable_code,
                reason = "the subscription loop exits only through errors"
            )]
            Ok::<(), IndexerError>(())
        };
        tokio::select! {
            result=announce=>result,
            result=self.live(receiver.clone())=>result,
            result=self.backfill(receiver.clone())=>result,
            result=self.reconcile(receiver)=>result,
        }
    }
    async fn initialize(&self, target: Target) -> Result<(), IndexerError> {
        for domain in DOMAINS {
            let expected = self.store.generation(domain).await?;
            let start = if domain == Indexable::Authorship {
                target.height
            } else {
                0
            };
            check(
                self.store
                    .initialize_coverage(domain, expected, start.into())
                    .await?,
            )?;
            // An archive rotation can restore data below yesterday's floor.
            check(
                self.store
                    .set_pruned_floor(
                        &GenerationGuard {
                            indexable: domain,
                            expected,
                        },
                        None,
                    )
                    .await?,
            )?;
        }
        self.observe(target).await?;
        if self
            .store
            .committed_target(&RetainedBlock {
                height: target.height.into(),
                hash: model_hash(target.hash),
            })
            .await?
        {
            self.committed(target.height);
        }
        Ok(())
    }
    async fn observe(&self, target: Target) -> Result<(), IndexerError> {
        // The watchdog must see advancing heads even when the writer is stalled.
        self.progress.send_modify(|p| {
            p.finalized_height = Some(
                p.finalized_height
                    .map_or(target.height, |h| h.max(target.height)),
            );
        });
        check(
            self.store
                .set_finalized_target(&RetainedBlock {
                    height: target.height.into(),
                    hash: model_hash(target.hash),
                })
                .await?,
        )?;
        Ok(())
    }
    fn error(&self, error: &IndexerError) {
        tracing::warn!(%error,"indexer work remains uncovered");
        self.progress.send_modify(|p| {
            p.last_error = Some(error.to_string());
            p.admitted = self.admission.active();
        });
    }
    fn committed(&self, height: u64) {
        self.progress.send_modify(|p| {
            p.committed_height = Some(p.committed_height.map_or(height, |h| h.max(height)));
            p.admitted = self.admission.active();
            p.last_error = None;
        });
    }
    /// Evaluate the shared backfill gate against the live validator state.
    ///
    /// Returns whether the backfill worker must pause this round. Errors
    /// reading sync state are treated as a pause: when the connection is
    /// unhealthy the gate holds rather than racing the validator.
    async fn sync_gate_decision(&self, finalized: u64) -> Result<bool, IndexerError> {
        let sync = self.chain.sync_state().await?;
        let metrics = self.chain.metrics().await;
        let best = self
            .progress
            .subscribe()
            .borrow()
            .best_height
            .unwrap_or(finalized);
        let sample = sync_gate::Sample::from_metrics(&metrics);
        Ok(self
            .sync_gate
            .lock()
            .await
            .evaluate(&sync, finalized, best, sample)
            .paused)
    }
}
fn model_hash(hash: BlockHash) -> ModelHash {
    ModelHash::from(hash.0)
}
fn chain_hash(hash: &ModelHash) -> BlockHash {
    BlockHash(*hash.as_bytes())
}
fn decimal(text: &str) -> Result<DecimalString, IndexerError> {
    text.parse()
        .map_err(|e: dashboard_model::DecimalStringError| IndexerError::Invalid(e.to_string()))
}
fn iso_timestamp(seconds: u64) -> Result<String, IndexerError> {
    let seconds = i64::try_from(seconds).map_err(|e| IndexerError::Invalid(e.to_string()))?;
    chrono::DateTime::from_timestamp(seconds, 0)
        .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(|| IndexerError::Invalid("timestamp outside supported range".into()))
}
fn check(result: CommitResult) -> Result<(), IndexerError> {
    match result {
        CommitResult::Applied | CommitResult::AlreadyApplied => Ok(()),
        CommitResult::StaleGeneration => Err(IndexerError::StaleGeneration),
    }
}
fn fatal(error: &IndexerError) -> bool {
    match error {
        IndexerError::Chain(ChainError::GenesisMismatch { .. })
        | IndexerError::Store(
            StoreError::NetworkIdentity
            | StoreError::ConflictingHistory(_)
            | StoreError::Invalid(_),
        )
        | IndexerError::Invalid(_) => true,
        IndexerError::Chain(_) | IndexerError::Store(_) | IndexerError::StaleGeneration => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{BlockHash, ChainReader, Indexer, ModelHash, Store, Target};
    use dashboard_store::StoreConfig;
    use sqlx::{
        ConnectOptions, Connection, Executor,
        postgres::{PgConnectOptions, PgConnection},
    };
    use std::{str::FromStr, sync::Arc, time::Duration};

    #[tokio::test]
    #[ignore = "requires an explicitly supplied disposable loopback PostgreSQL database"]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test assertions report watchdog visibility regressions"
    )]
    async fn received_finalized_head_remains_visible_while_target_write_is_blocked()
    -> Result<(), Box<dyn std::error::Error>> {
        let url = std::env::var("QUIP_INDEXER_TEST_POSTGRES_URL")?;
        let options = PgConnectOptions::from_str(&url)?;
        if options.get_host() != "127.0.0.1"
            || !options
                .get_database()
                .is_some_and(|name| name.starts_with("quip_indexer_pressure_"))
        {
            return Err("head visibility test requires a unique quip_indexer_pressure_ database on 127.0.0.1".into());
        }
        let store = Arc::new(
            Store::open(StoreConfig::Postgres {
                url,
                max_connections: 4,
            })
            .await?,
        );
        store.bind_network(&ModelHash::from([0; 32]), &[]).await?;
        let chain = Arc::new(ChainReader::new("http://127.0.0.1:1", BlockHash([0; 32])));
        let (indexer, mut progress) = Indexer::new(store.clone(), chain);
        let indexer = Arc::new(indexer);
        indexer
            .observe(Target {
                height: 10,
                hash: BlockHash([10; 32]),
            })
            .await?;
        assert_eq!(
            store
                .finalized_target()
                .await?
                .ok_or("target missing")?
                .height
                .to_u64()?,
            10
        );
        let mut blocker = PgConnection::connect_with(&options.disable_statement_logging()).await?;
        let mut transaction = blocker.begin().await?;
        let _ = transaction
            .execute("LOCK TABLE meta IN ACCESS EXCLUSIVE MODE")
            .await?;
        let pending_indexer = indexer.clone();
        let mut pending = tokio::spawn(async move {
            pending_indexer
                .observe(Target {
                    height: 11,
                    hash: BlockHash([11; 32]),
                })
                .await
        });
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            progress.wait_for(|state| state.finalized_height == Some(11)),
        )
        .await??;
        assert_eq!(progress.borrow().committed_height, None);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut pending)
                .await
                .is_err()
        );
        transaction.commit().await?;
        pending.await??;
        assert_eq!(
            store
                .finalized_target()
                .await?
                .ok_or("target missing")?
                .height
                .to_u64()?,
            11
        );
        assert_eq!(progress.borrow().committed_height, None);
        Ok(())
    }
}

#[cfg(test)]
mod restore_tests;
