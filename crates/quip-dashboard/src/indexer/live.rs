// SPDX-License-Identifier: AGPL-3.0-or-later
use super::{
    DOMAINS, Indexer, IndexerError, PAGE_SIZE, Target, check, decimal, iso_timestamp, model_hash,
};
use crate::chain::{BlockPurpose, ChainError, DecodedBlock, DifficultyInfo, WorkClass};
use dashboard_model::{BlockRecord, DifficultyRecord, DifficultySource, QBlockParticipationRecord};
use dashboard_store::{
    AuthorshipRecord, BlockCommit, BlockRecords, CommitResult, GenerationGuard, Indexable,
    UnavailableBlock, UnavailableReason,
};
use std::time::Duration;
use tokio::sync::watch;

enum DomainResult<T> {
    Complete(Option<T>),
    Unavailable(UnavailableReason),
}

impl Indexer {
    pub(super) async fn live(
        &self,
        mut targets: watch::Receiver<Target>,
    ) -> Result<(), IndexerError> {
        loop {
            let target = *targets.borrow_and_update();
            // A single live worker owns at most one slot, including backoff and commit.
            let permit = self
                .admission
                .try_live()
                .map_err(|e| IndexerError::Invalid(e.to_string()))?;
            self.progress
                .send_modify(|progress| progress.admitted = self.admission.active());
            self.process(target.height, target, WorkClass::Live).await?;
            drop(permit);
            self.progress
                .send_modify(|progress| progress.admitted = self.admission.active());
            targets
                .changed()
                .await
                .map_err(|_| ChainError::Disconnected)?;
        }
    }
    pub(super) async fn guards(
        &self,
        height: u64,
        authorship: bool,
    ) -> Result<Vec<GenerationGuard>, IndexerError> {
        let mut guards = Vec::new();
        for indexable in DOMAINS {
            if indexable == Indexable::Authorship && !authorship {
                continue;
            }
            let expected = self.store.generation(indexable).await?;
            let coverage = self.store.coverage(indexable).await?;
            if coverage.as_ref().is_some_and(|c| {
                c.r#gen == expected
                    && (height < c.start
                        || c.pruned_floor.is_some_and(|floor| height <= floor)
                        || c.contains(height, height))
            }) {
                continue;
            }
            if self
                .store
                .is_unavailable(indexable, expected, height)
                .await?
            {
                continue;
            }
            guards.push(GenerationGuard {
                indexable,
                expected,
            });
        }
        Ok(guards)
    }
    pub(super) async fn process(
        &self,
        height: u64,
        target: Target,
        class: WorkClass,
    ) -> Result<(), IndexerError> {
        // Replay callers share the same lane as the subscription worker.
        let _work = match class {
            WorkClass::Live => self.live_work.lock().await,
            WorkClass::Backfill => self.backfill_work.lock().await,
        };
        let guards = self.guards(height, true).await?;
        if guards.is_empty() {
            return Ok(());
        }
        let Some(decoded) = self.decode_block(height, target, class, &guards).await? else {
            return Ok(());
        };
        let mut batch = BlockCommit {
            genesis: model_hash(self.chain.genesis()),
            hash: model_hash(decoded.hash),
            height: height.into(),
            guards: guards.clone(),
            records: BlockRecords::default(),
            completed: Vec::new(),
        };
        for guard in &guards {
            match guard.indexable {
                Indexable::Authorship => {
                    batch.records.authorship =
                        decoded
                            .events
                            .author
                            .as_ref()
                            .map(|account| AuthorshipRecord {
                                account_id: account.clone(),
                                block_number: height.into(),
                                timestamp: decoded.events.timestamp,
                                had_winner: decoded.events.winner.is_some(),
                            });
                    batch.completed.push(Indexable::Authorship);
                }
                Indexable::Winners => match self.winner(&decoded, class).await {
                    Ok(DomainResult::Complete(record)) => {
                        batch.records.winner = record;
                        batch.completed.push(Indexable::Winners);
                    }
                    Ok(DomainResult::Unavailable(reason)) => {
                        self.mark_unavailable(&decoded, guard, reason).await?;
                    }
                    Err(error) => self.error(&error),
                },
                Indexable::Difficulty => match self.historical_difficulty(&decoded, class).await {
                    Ok(DomainResult::Complete(record)) => {
                        batch.records.difficulty = record;
                        batch.completed.push(Indexable::Difficulty);
                    }
                    Ok(DomainResult::Unavailable(reason)) => {
                        self.mark_unavailable(&decoded, guard, reason).await?;
                    }
                    Err(error) => self.error(&error),
                },
                Indexable::Participation => {}
            }
        }
        if !batch.completed.is_empty() {
            check(self.store.commit_block(&batch).await?)?;
            self.write_files(batch.records.winner.as_ref(), &[]).await;
            self.committed(height);
        }
        if let Some(guard) = guards
            .iter()
            .find(|g| g.indexable == Indexable::Participation)
            && let Err(error) = self.participation(&decoded, guard, class).await
        {
            match error {
                IndexerError::Chain(error) => self.error(&IndexerError::Chain(error)),
                error => return Err(error),
            }
        }
        if class == WorkClass::Live
            && let Err(error) = self.refresh_changes(&decoded).await
        {
            // The paged registry reconciliation retries failed targeted reads.
            match error {
                IndexerError::Chain(error) => self.error(&IndexerError::Chain(error)),
                error => return Err(error),
            }
        }
        Ok(())
    }
    async fn mark_unavailable(
        &self,
        block: &DecodedBlock,
        guard: &GenerationGuard,
        reason: UnavailableReason,
    ) -> Result<(), IndexerError> {
        let result = self
            .store
            .mark_unavailable(
                &model_hash(self.chain.genesis()),
                &UnavailableBlock {
                    guard: guard.clone(),
                    height: block.events.block_number.into(),
                    hash: model_hash(block.hash),
                    enrichment_at: model_hash(block.enrichment_at),
                    reason,
                },
            )
            .await?;
        if result == CommitResult::Applied {
            tracing::warn!(
                domain = guard.indexable.name(), generation = guard.expected,
                height = block.events.block_number, hash = %block.hash,
                enrichment_at = %block.enrichment_at, reason = reason.name(),
                "retained data unavailable; explicit reindex required to retry"
            );
        }
        check(result)
    }
    async fn decode_block(
        &self,
        height: u64,
        target: Target,
        class: WorkClass,
        guards: &[GenerationGuard],
    ) -> Result<Option<std::sync::Arc<DecodedBlock>>, IndexerError> {
        let full = guards.iter().any(|g| g.indexable == Indexable::Authorship);
        let purpose = if full {
            BlockPurpose::Full
        } else {
            BlockPurpose::WinnerOnly
        };
        let hash =
            self.chain.block_hash(height, class).await?.ok_or_else(|| {
                IndexerError::Invalid(format!("missing finalized block {height}"))
            })?;
        let mut delay = Duration::from_secs(1);
        let mut attempts = 0;
        let decoded = loop {
            match self.chain.block(hash, purpose, target.hash, class).await {
                Ok(block) => break block,
                Err(ChainError::Pruned(message)) => {
                    for guard in guards {
                        let old = self
                            .store
                            .coverage(guard.indexable)
                            .await?
                            .and_then(|c| c.pruned_floor);
                        check(
                            self.store
                                .set_pruned_floor(
                                    guard,
                                    Some(old.map_or(height, |n| n.max(height)).into()),
                                )
                                .await?,
                        )?;
                    }
                    self.error(&IndexerError::Chain(ChainError::Pruned(message)));
                    return Ok(None);
                }
                Err(error) => {
                    let error = IndexerError::Chain(error);
                    self.error(&error);
                    attempts += 1;
                    if attempts >= 3 {
                        return Err(error);
                    }
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(Duration::from_secs(30));
                }
            }
        };
        if decoded.header.height()? != height || decoded.hash != hash {
            return Err(IndexerError::Invalid(
                "decoded finalized block identity differs from request".into(),
            ));
        }
        Ok(Some(decoded))
    }
    async fn winner(
        &self,
        block: &DecodedBlock,
        class: WorkClass,
    ) -> Result<DomainResult<BlockRecord>, IndexerError> {
        let Some(winner) = &block.events.winner else {
            return Ok(DomainResult::Complete(None));
        };
        if let Some(error) = &block.qblock_error {
            return Err(error.clone().into());
        }
        let Some(proof) = block
            .events
            .proofs
            .iter()
            .find(|p| p.miner == winner.miner && p.energy_milli == winner.energy_milli)
        else {
            tracing::warn!(
                height = block.events.block_number,
                "winner has no matching accepted proof"
            );
            return Ok(DomainResult::Complete(None));
        };
        let Some(nonce) = &block.events.nonce else {
            return Ok(DomainResult::Unavailable(
                UnavailableReason::MissingRetainedNonce,
            ));
        };
        let previous = if block.events.block_number == 0 {
            0
        } else {
            self.chain
                .last_proof_block(block.header.parent_hash, class)
                .await?
        };
        let spacing = if previous > 0 {
            block.events.block_number.saturating_sub(previous).max(1)
        } else {
            0
        };
        let device = block
            .qblock
            .as_ref()
            .and_then(|q| q.device_access_time_us)
            .filter(|n| *n > 0);
        let topology_hash = self.chain.default_topology(block.hash, class).await?;
        let topology = match topology_hash {
            Some(hash) => Some(self.chain.topology_summary(block.hash, hash, class).await?),
            None => None,
        };
        let zero = DifficultyInfo {
            max_energy_milli: 0,
            min_diversity_milli: 0,
            min_solutions: 0,
        };
        let difficulty = block.qblock.as_ref().map_or(&zero, |q| &q.difficulty);
        Ok(DomainResult::Complete(Some(BlockRecord {
            block_hash: model_hash(block.hash),
            substrate_block_number: block.events.block_number.into(),
            substrate_block_hash: model_hash(block.hash),
            substrate_parent_hash: model_hash(block.header.parent_hash),
            timestamp: block.events.timestamp,
            miner_id: winner.miner.clone(),
            energy: milli_energy(winner.energy_milli),
            diversity: f64::from(proof.diversity_milli) / 1000.0,
            num_valid_solutions: u64::from(proof.valid_solution_count),
            mining_time: mining_seconds(device, spacing),
            device_access_time_us: device,
            reward: decimal(&winner.reward)?,
            qblock_id: winner.qblock_id.into(),
            nonce: decimal(nonce)?,
            num_nodes: topology.as_ref().map_or(0, |t| t.node_count),
            num_edges: topology.as_ref().map_or(0, |t| t.edge_count),
            difficulty_energy: milli_energy(difficulty.max_energy_milli),
            min_diversity: f64::from(difficulty.min_diversity_milli) / 1000.0,
            min_solutions: difficulty.min_solutions,
            finalized: true,
            topology_hash: topology_hash.map(model_hash),
        })))
    }
    async fn historical_difficulty(
        &self,
        block: &DecodedBlock,
        class: WorkClass,
    ) -> Result<DomainResult<DifficultyRecord>, IndexerError> {
        if block.events.winner.is_none() {
            return Ok(DomainResult::Complete(None));
        }
        if let Some(error) = &block.qblock_error {
            return Err(error.clone().into());
        }
        let Some(qblock) = &block.qblock else {
            return Ok(DomainResult::Unavailable(
                UnavailableReason::MissingRetainedDifficulty,
            ));
        };
        let topology = self.chain.default_topology(block.hash, class).await?;
        Ok(DomainResult::Complete(Some(DifficultyRecord {
            observed_at_block: block.events.block_number.into(),
            difficulty_energy: milli_energy(qblock.difficulty.max_energy_milli),
            min_diversity: f64::from(qblock.difficulty.min_diversity_milli) / 1000.0,
            min_solutions: qblock.difficulty.min_solutions,
            observed_at: iso_timestamp(block.events.timestamp)?,
            topology_hash: topology.map(model_hash),
            source: DifficultySource::Block,
        })))
    }
    async fn participation(
        &self,
        block: &DecodedBlock,
        guard: &GenerationGuard,
        class: WorkClass,
    ) -> Result<(), IndexerError> {
        let mut cursor = None;
        loop {
            let mut records = Vec::new();
            let exhausted = if let Some(winner) = &block.events.winner {
                let page = self
                    .chain
                    .participant_page(
                        block.enrichment_at,
                        winner.qblock_id,
                        cursor.clone(),
                        PAGE_SIZE,
                        class,
                    )
                    .await?;
                if page.at != block.enrichment_at
                    || (!page.exhausted && page.continuation.is_none())
                    || (!page.exhausted && page.continuation == cursor)
                {
                    return Err(IndexerError::Invalid(
                        "participant page failed to advance pinned cursor".into(),
                    ));
                }
                for p in page.participants {
                    records.push(QBlockParticipationRecord {
                        qblock_id: winner.qblock_id.into(),
                        account: p.account,
                        kind: p.kind,
                        budget_seconds: p.budget_seconds.map(f64::from),
                        block_number: p.block_number.into(),
                    });
                }
                cursor = page.continuation;
                page.exhausted
            } else {
                true
            };
            let completed = if exhausted {
                vec![Indexable::Participation]
            } else {
                Vec::new()
            };
            let batch = BlockCommit {
                genesis: model_hash(self.chain.genesis()),
                hash: model_hash(block.hash),
                height: block.events.block_number.into(),
                guards: vec![guard.clone()],
                records: BlockRecords {
                    participation: records.clone(),
                    ..BlockRecords::default()
                },
                completed,
            };
            check(self.store.commit_block(&batch).await?)?;
            self.write_files(None, &records).await;
            if exhausted {
                self.committed(block.events.block_number);
                return Ok(());
            }
            tokio::task::yield_now().await;
        }
    }
}
#[expect(
    clippy::cast_precision_loss,
    reason = "public energy DTO is f64; chain source remains signed milli-energy"
)]
pub(super) fn milli_energy(value: i64) -> f64 {
    value as f64 / 1000.0
}
#[expect(
    clippy::cast_precision_loss,
    reason = "public mining duration is fractional seconds"
)]
fn mining_seconds(device: Option<u64>, spacing: u64) -> f64 {
    device.map_or(spacing as f64 * 6.0, |us| us as f64 / 1_000_000.0)
}

#[cfg(test)]
mod tests {
    use super::{Indexer, Target};
    use crate::chain::{BlockHash, ChainReader};
    use dashboard_model::BlockHash as ModelHash;
    use dashboard_store::{Indexable, Store, StoreConfig};
    use jsonrpsee::{RpcModule, server::ServerBuilder, types::ErrorObjectOwned};
    use parity_scale_codec::Encode;
    use serde_json::{Value, json};
    use std::{sync::Arc, time::Duration};
    use tokio::sync::{Notify, watch};

    fn hash(height: u64) -> BlockHash {
        let mut bytes = [0; 32];
        if let Some(prefix) = bytes.get_mut(..8) {
            prefix.copy_from_slice(&height.to_le_bytes());
        }
        BlockHash(bytes)
    }
    fn hex(bytes: impl AsRef<[u8]>) -> Value {
        json!(format!("0x{}", hex::encode(bytes)))
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test assertions report live scheduler pressure"
    )]
    async fn hundred_thousand_heads_coalesce_while_one_rpc_is_slow()
    -> Result<(), Box<dyn std::error::Error>> {
        let server = ServerBuilder::default().build("127.0.0.1:0").await?;
        let address = server.local_addr()?;
        let entered = Arc::new(Notify::new());
        let released = Arc::new(Notify::new());
        let mut module = RpcModule::new((entered.clone(), released.clone()));
        for method in [
            "chain_getBlockHash",
            "chain_getHeader",
            "state_getStorageHash",
            "state_getRuntimeVersion",
            "state_getMetadata",
            "state_getStorage",
        ] {
            let _ = module.register_async_method(method, move |params, gate, _| async move {
                let params = params.parse::<Option<Vec<Value>>>()?.unwrap_or_default();
                let state = params.last().and_then(Value::as_str).and_then(|s| hex::decode(s.trim_start_matches("0x")).ok());
                let height = state.as_ref().and_then(|bytes| bytes.get(..8)).and_then(|bytes| <[u8; 8]>::try_from(bytes).ok()).map_or(0, u64::from_le_bytes);
                let response = match method {
                    "chain_getBlockHash" => { let height = params.first().and_then(|value| value.as_u64().or_else(|| value.as_str().and_then(|value| u64::from_str_radix(value.trim_start_matches("0x"), 16).ok()))).unwrap_or(0); json!(hash(height)) },
                    "chain_getHeader" => json!({"number": format!("0x{height:x}"), "parentHash": hash(height.saturating_sub(1)), "stateRoot": hash(0), "extrinsicsRoot": hash(0), "digest": {"logs": []}}),
                    "state_getStorageHash" => json!(hash(42)),
                    "state_getRuntimeVersion" => json!({"specName":"quip","implName":"fixture","specVersion":117,"transactionVersion":7}),
                    "state_getMetadata" => hex(include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/chain/runtime-old-v16.scale"))),
                    "state_getStorage" => {
                        let events = format!("0x{}", hex::encode(subxt_core::storage::get_address_root_bytes(&subxt_core::dynamic::storage("System", "Events", Vec::<scale_value::Value>::new()))));
                        if params.first().and_then(Value::as_str) == Some(events.as_str()) {
                            if height == 1 { gate.0.notify_one(); gate.1.notified().await; }
                            hex([0])
                        } else { hex(1_710_000_000_000_u64.encode()) }
                    },
                    method => return Err(ErrorObjectOwned::owned(-32601, method, None::<()>)),
                };
                Ok::<Value, ErrorObjectOwned>(response)
            })?;
        }
        let server = server.start(module);
        let directory = tempfile::tempdir()?;
        let store = Arc::new(
            Store::open(StoreConfig::Turso {
                path: directory.path().join("heads.db"),
            })
            .await?,
        );
        store.bind_network(&ModelHash::from([0; 32]), &[]).await?;
        let chain = Arc::new(ChainReader::new(format!("http://{address}"), hash(0)));
        chain.connect().await?;
        let (indexer, _) = Indexer::new(store.clone(), chain.clone());
        let indexer = Arc::new(indexer);
        let (targets, receiver) = watch::channel(Target {
            height: 1,
            hash: hash(1),
        });
        let running = indexer.clone();
        let worker = tokio::spawn(async move { running.live(receiver).await });
        tokio::time::timeout(Duration::from_secs(5), entered.notified()).await?;
        for height in 2..=100_001 {
            let _ = targets.send_replace(Target {
                height,
                hash: hash(height),
            });
            assert_eq!(indexer.admission.active(), 1);
        }
        assert!(store.coverage(Indexable::Authorship).await?.is_none());
        released.notify_one();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if store
                    .coverage(Indexable::Authorship)
                    .await?
                    .is_some_and(|c| c.contains(100_001, 100_001))
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
            Ok::<(), dashboard_store::StoreError>(())
        })
        .await??;
        let coverage = store
            .coverage(Indexable::Authorship)
            .await?
            .ok_or("coverage missing")?;
        assert_eq!(coverage.gaps, vec![[2, 100_000]]);
        assert!(indexer.admission.active() <= 1);
        worker.abort();
        let _ = worker.await;
        assert_eq!(indexer.admission.active(), 0);
        chain.disconnect().await?;
        server.stop()?;
        Ok(())
    }
}
