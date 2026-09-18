// SPDX-License-Identifier: AGPL-3.0-or-later
use super::live::milli_energy;
use super::{Indexer, IndexerError, PAGE_SIZE, Target, decimal, iso_timestamp, model_hash};
use crate::chain::{ChainError, ChainMinerInfo, DecodedBlock, DescriptorEntry, WorkClass};
use dashboard_model::{
    BabeAuthorityRecord, BabeEpochState, ChainHead, ChainMinerRecord, DifficultyRecord,
    DifficultySource, MineableTopologyRecord, NodeDescriptorRecord, RuntimeVersion,
};
use std::time::Duration;
use tokio::{sync::watch, time::Instant};

impl Indexer {
    pub(super) async fn reconcile(
        &self,
        mut targets: watch::Receiver<Target>,
    ) -> Result<(), IndexerError> {
        let mut next_registry = Instant::now();
        loop {
            let target = *targets.borrow_and_update();
            self.dynamic_snapshot(target).await?;
            if Instant::now() >= next_registry {
                self.registry_snapshot(target).await?;
                next_registry = Instant::now() + Duration::from_mins(15);
            }
            tokio::select! {
                result=targets.changed()=>result.map_err(|_|ChainError::Disconnected)?,
                ()=tokio::time::sleep_until(next_registry)=>{}
            }
        }
    }
    async fn dynamic_snapshot(&self, target: Target) -> Result<(), IndexerError> {
        let at = target.hash;
        self.epoch_snapshot(at).await?;
        let topologies = self.chain.mineable_topologies(at, WorkClass::Live).await?;
        let mut records = Vec::with_capacity(topologies.len());
        for t in topologies {
            let difficulty = t.difficulty.ok_or_else(|| {
                IndexerError::Invalid("mineable topology has no difficulty".into())
            })?;
            records.push(MineableTopologyRecord {
                topology_hash: model_hash(t.topology.topology_hash),
                is_default: t.is_default,
                difficulty_energy: milli_energy(difficulty.max_energy_milli),
                min_diversity: f64::from(difficulty.min_diversity_milli) / 1000.0,
                min_solutions: difficulty.min_solutions,
                node_count: t.topology.node_count,
                edge_count: t.topology.edge_count,
                curve_constant: t.topology.curve_constant,
            });
        }
        self.store.set_mineable_topologies(&records).await?;
        let difficulty = self.chain.difficulty(at, WorkClass::Live).await?;
        let topology = self.chain.default_topology(at, WorkClass::Live).await?;
        let timestamp = self.chain.timestamp(at, WorkClass::Live).await?;
        self.store
            .insert_difficulty_snapshot(&DifficultyRecord {
                observed_at_block: target.height.into(),
                difficulty_energy: milli_energy(difficulty.max_energy_milli),
                min_diversity: f64::from(difficulty.min_diversity_milli) / 1000.0,
                min_solutions: difficulty.min_solutions,
                observed_at: iso_timestamp(timestamp)?,
                topology_hash: topology.map(model_hash),
                source: DifficultySource::Poll,
            })
            .await?;
        let context = self.chain.runtime_context(at, WorkClass::Live).await?;
        let qblocks = self.chain.qblock_count(at, WorkClass::Live).await?;
        let current = qblocks
            .checked_add(1)
            .ok_or_else(|| IndexerError::Invalid("qblock count overflow".into()))?;
        let participants = match self
            .chain
            .participant_count(at, current, WorkClass::Live)
            .await
        {
            Ok(n) => Some(u64::from(n)),
            Err(ChainError::Unsupported(_)) => None,
            Err(error) => return Err(error.into()),
        };
        let best = self
            .progress
            .borrow()
            .best_height
            .unwrap_or(target.height)
            .max(target.height);
        let best_hash = self
            .chain
            .block_hash(best, WorkClass::Live)
            .await?
            .ok_or_else(|| IndexerError::Invalid("best head hash unavailable".into()))?;
        self.store
            .upsert_chain_head(&ChainHead {
                best_block_number: best.into(),
                best_block_hash: model_hash(best_hash),
                finalized_block_number: target.height.into(),
                finalized_block_hash: model_hash(at),
                finality_lag: i64::try_from(best - target.height)
                    .map_err(|e| IndexerError::Invalid(e.to_string()))?,
                qblock_count: Some(qblocks),
                current_qblock_id: Some(current.into()),
                current_qblock_participants: participants,
                runtime: RuntimeVersion {
                    spec_name: context.version.spec_name.clone(),
                    spec_version: context.version.spec_version,
                    transaction_version: context.version.transaction_version,
                    impl_name: context.version.impl_name.clone(),
                    last_runtime_upgrade: self
                        .chain
                        .last_runtime_upgrade(at, WorkClass::Live)
                        .await?
                        .map(|n| u64::from(n).into()),
                },
                updated_at: iso_timestamp(timestamp)?,
            })
            .await?;
        Ok(())
    }
    async fn epoch_snapshot(&self, at: crate::chain::BlockHash) -> Result<(), IndexerError> {
        // Each consumer uses the shared reader; identical epoch/storage calls share its cache.
        let epoch = self.chain.babe_epoch(at, WorkClass::Live).await?;
        self.store
            .upsert_babe_epoch(&BabeEpochState {
                epoch_index: epoch.epoch_index,
                current_slot: epoch.current_slot.into(),
                epoch_start_slot: epoch.epoch_start_slot.into(),
                slots_per_epoch: epoch.slots_per_epoch,
                current_slot_in_epoch: epoch.current_slot.saturating_sub(epoch.epoch_start_slot),
                authority_count: u32::try_from(epoch.authorities.len())
                    .map_err(|e| IndexerError::Invalid(e.to_string()))?,
            })
            .await?;
        let authorities = epoch
            .authorities
            .into_iter()
            .map(|account_id| BabeAuthorityRecord {
                account_id,
                display_name: None,
            })
            .collect::<Vec<_>>();
        self.store
            .upsert_babe_authorities(epoch.epoch_index, &authorities)
            .await?;
        Ok(())
    }
    async fn registry_snapshot(&self, _target: Target) -> Result<(), IndexerError> {
        // Serialize targeted updates with the reconciliation snapshot so counters cannot regress.
        let _registry = self.registry.lock().await;
        let at = self.chain.finalized_head().await?;
        let target = Target {
            height: self.chain.header(at, WorkClass::Backfill).await?.height()?,
            hash: at,
        };
        let mut cursor = None;
        loop {
            let page = self
                .chain
                .miner_page(at, cursor, PAGE_SIZE, WorkClass::Backfill)
                .await?;
            let records = page
                .miners
                .into_iter()
                .map(miner_record)
                .collect::<Result<Vec<_>, _>>()?;
            self.store.upsert_chain_miners(&records).await?;
            cursor = page.continuation;
            if page.exhausted {
                break;
            }
            if cursor.is_none() {
                return Err(IndexerError::Invalid(
                    "miner page lacks continuation".into(),
                ));
            }
            tokio::task::yield_now().await;
        }
        let mut cursor = None;
        loop {
            let (entries, next) = self
                .chain
                .descriptor_page(at, cursor, WorkClass::Backfill)
                .await?;
            for entry in entries {
                self.descriptor(entry, None).await?;
            }
            cursor = next;
            if cursor.is_none() {
                break;
            }
            tokio::task::yield_now().await;
        }
        self.store
            .set_descriptor_checkpoint(&target.height.to_string())
            .await?;
        Ok(())
    }
    pub(super) async fn refresh_changes(&self, block: &DecodedBlock) -> Result<(), IndexerError> {
        if block.events.registry_changes.is_empty() && block.events.miner_changes.is_empty() {
            return Ok(());
        }
        let _registry = self.registry.lock().await;
        let at = self.chain.finalized_head().await?;
        for change in &block.events.registry_changes {
            if let Some(entry) = self
                .chain
                .descriptor_at(at, change.account, WorkClass::Live)
                .await?
            {
                let first_seen =
                    (change.event == "DescriptorUpdated").then_some(block.events.timestamp);
                self.descriptor(entry, first_seen).await?;
            }
        }
        let accounts = block
            .events
            .registry_changes
            .iter()
            .map(|change| change.account)
            .chain(block.events.miner_changes.iter().copied())
            .collect::<std::collections::BTreeSet<_>>();
        for account in accounts {
            if let Some(miner) = self.chain.miner_at(at, account, WorkClass::Live).await? {
                self.store
                    .upsert_chain_miners(&[miner_record(miner)?])
                    .await?;
            }
        }
        Ok(())
    }
    /// Lower persisted descriptor first-seen timestamps with historical presence reads.
    /// Presence is assumed monotonic, matching the existing archive reconstruction command.
    /// Traversal retains one bounded descriptor page and searches each account independently.
    /// # Errors
    /// Returns pruning, transport, decoding, or database errors without guessing missing history.
    pub async fn reconstruct_first_seen(&self) -> Result<u64, IndexerError> {
        let at = self.chain.finalized_head().await?;
        let height = self.chain.header(at, WorkClass::Backfill).await?.height()?;
        if height == 0 {
            return Ok(0);
        }
        let mut cursor = None;
        let mut processed = 0_u64;
        loop {
            let (entries, next) = self
                .chain
                .descriptor_page(at, cursor, WorkClass::Backfill)
                .await?;
            for entry in entries {
                if self
                    .store
                    .get_node_descriptor(&entry.account_id)
                    .await?
                    .is_none()
                {
                    continue;
                }
                let mut low = 1;
                let mut high = height;
                while low < high {
                    let middle = low + (high - low) / 2;
                    let hash = self
                        .chain
                        .block_hash(middle, WorkClass::Backfill)
                        .await?
                        .ok_or_else(|| {
                            IndexerError::Invalid("descriptor history block hash missing".into())
                        })?;
                    if self
                        .chain
                        .descriptor_present(hash, entry.account, WorkClass::Backfill)
                        .await?
                    {
                        high = middle;
                    } else {
                        low = middle + 1;
                    }
                }
                let hash = self
                    .chain
                    .block_hash(low, WorkClass::Backfill)
                    .await?
                    .ok_or_else(|| {
                        IndexerError::Invalid("first descriptor block hash missing".into())
                    })?;
                let timestamp = self.chain.timestamp(hash, WorkClass::Backfill).await?;
                self.store
                    .backfill_node_descriptor_first_seen(&entry.account_id, timestamp)
                    .await?;
                processed = processed
                    .checked_add(1)
                    .ok_or_else(|| IndexerError::Invalid("descriptor count overflow".into()))?;
                tokio::task::yield_now().await;
            }
            cursor = next;
            if cursor.is_none() {
                return Ok(processed);
            }
        }
    }
    async fn descriptor(
        &self,
        entry: DescriptorEntry,
        first_seen: Option<u64>,
    ) -> Result<(), IndexerError> {
        let descriptor = serde_json::from_value(entry.descriptor)
            .map_err(|e| IndexerError::Invalid(e.to_string()))?;
        self.store
            .upsert_node_descriptor(&NodeDescriptorRecord {
                account_id: entry.account_id,
                block_number: entry.updated_at.into(),
                block_hash: model_hash(entry.block_hash),
                extrinsic_index: 0,
                block_timestamp: entry.timestamp,
                first_block_timestamp: first_seen
                    .map_or(entry.timestamp, |timestamp| timestamp.min(entry.timestamp)),
                descriptor,
                observed_at: iso_timestamp(entry.timestamp)?,
            })
            .await?;
        Ok(())
    }
}
fn miner_record(miner: ChainMinerInfo) -> Result<ChainMinerRecord, IndexerError> {
    Ok(ChainMinerRecord {
        account_id: miner.account_id,
        deposit: decimal(&miner.deposit)?,
        proofs_submitted: miner.proofs_submitted.into(),
        proofs_won: miner.proofs_won.into(),
        rewards_earned: decimal(&miner.rewards_earned)?,
        telemetry_node_address: None,
        hardware: None,
    })
}
