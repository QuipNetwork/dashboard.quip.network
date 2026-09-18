// SPDX-License-Identifier: AGPL-3.0-or-later
use super::{
    Indexer, IndexerError, PAGE_SIZE, SPARSE, Target, chain_hash, check, coverage::uncovered,
    model_hash,
};
use crate::chain::{WinnerCursor, WorkClass};
use dashboard_store::{Indexable, RangeCompletion, Scan, ScanId};
use std::time::Duration;
use tokio::{sync::watch, time::Instant};

impl Indexer {
    pub(super) async fn backfill(
        &self,
        targets: watch::Receiver<Target>,
    ) -> Result<(), IndexerError> {
        let mut next = Instant::now();
        loop {
            let announced = *targets.borrow();
            let durable = self.store.finalized_target().await?;
            let target = match durable {
                Some(row)
                    if row
                        .height
                        .to_u64()
                        .map_err(|e| IndexerError::Invalid(e.to_string()))?
                        > announced.height =>
                {
                    Target {
                        height: row
                            .height
                            .to_u64()
                            .map_err(|e| IndexerError::Invalid(e.to_string()))?,
                        hash: chain_hash(&row.hash),
                    }
                }
                Some(_) | None => announced,
            };
            // Determine whether any backfill work is pending. Only then consult
            // the sync gate, so we never add system_health/system_syncState probes
            // at steady state (live-up-to-date) when there is nothing to backfill.
            let has_authorship = self
                .store
                .coverage(Indexable::Authorship)
                .await?
                .is_some_and(|coverage| {
                    uncovered(&coverage, target.height)
                        .first()
                        .is_some_and(|[from, _]| *from <= target.height)
                });
            let has_sparse = {
                let mut pending = false;
                for domain in SPARSE {
                    if let Some(coverage) = self.store.coverage(domain).await?
                        && let Some([from, _]) = uncovered(&coverage, target.height).first()
                        && *from <= target.height
                    {
                        pending = true;
                        break;
                    }
                }
                pending
            };
            if has_authorship || has_sparse {
                // Pause the round while the validator is still syncing, under
                // sustained RPC latency, or while live work lags the finalized
                // head. The gate carries resume hysteresis so we do not thrash at
                // a sync boundary. When the sync read itself fails we treat it as
                // a pause rather than racing the validator.
                let paused = self.sync_gate_decision(target.height).await.unwrap_or(true);
                if paused {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
            }
            if let Some(coverage) = self.store.coverage(Indexable::Authorship).await?
                && let Some([from, _]) = uncovered(&coverage, target.height).first()
            {
                self.backfill_block(*from, target, &mut next).await?;
            }
            for domain in SPARSE {
                self.sparse_chunk(domain, target, &mut next).await?;
                tokio::task::yield_now().await;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
    async fn backfill_block(
        &self,
        height: u64,
        target: Target,
        next: &mut Instant,
    ) -> Result<(), IndexerError> {
        // The clock is set at admission, so time spent committing cannot accumulate tokens.
        tokio::time::sleep_until(*next).await;
        let permit = self
            .admission
            .try_backfill()
            .map_err(|e| IndexerError::Invalid(e.to_string()))?;
        self.progress
            .send_modify(|progress| progress.admitted = self.admission.active());
        *next = Instant::now() + Duration::from_secs(1);
        let result = self.process(height, target, WorkClass::Backfill).await;
        drop(permit);
        self.progress
            .send_modify(|progress| progress.admitted = self.admission.active());
        match result {
            Err(IndexerError::StaleGeneration) => Ok(()),
            Err(IndexerError::Chain(error)) => {
                self.error(&IndexerError::Chain(error));
                Ok(())
            }
            result => result,
        }
    }
    async fn sparse_chunk(
        &self,
        domain: Indexable,
        target: Target,
        next: &mut Instant,
    ) -> Result<(), IndexerError> {
        let generation = self.store.generation(domain).await?;
        check(
            self.store
                .initialize_coverage(domain, generation, 0_u64.into())
                .await?,
        )?;
        let Some(coverage) = self.store.coverage(domain).await? else {
            return Ok(());
        };
        let mut retryable = None;
        for [from, through] in uncovered(&coverage, target.height) {
            retryable = self
                .store
                .retryable_range(domain, generation, from, through)
                .await?;
            if retryable.is_some() {
                break;
            }
        }
        let Some([from, through]) = retryable else {
            return Ok(());
        };
        let old = self.store.active_scan(domain, generation).await?;
        let scan = if let Some(scan) =
            old.filter(|s| s.finalized_height.to_u64().is_ok_and(|n| n >= from))
        {
            scan
        } else {
            Scan {
                id: ScanId(format!("{}:{}:{}", domain.name(), generation, target.hash)),
                genesis: model_hash(self.chain.genesis()),
                at: model_hash(target.hash),
                finalized_height: target.height.into(),
                indexable: domain,
                expected_generation: generation,
            }
        };
        if let Err(IndexerError::StaleGeneration) = check(self.store.begin_scan(&scan).await?) {
            return Ok(());
        }
        if !self.enumerate_page(&scan).await? {
            return Ok(());
        }
        let at = chain_hash(&scan.at);
        let ceiling = scan
            .finalized_height
            .to_u64()
            .map_err(|e| IndexerError::Invalid(e.to_string()))?
            .min(through);
        let rows = self
            .store
            .scan_winners(&scan.id, from.checked_sub(1).map(Into::into), 16)
            .await?;
        let mut cursor = Some(from);
        let mut last = None;
        let count = rows.len();
        for height in rows {
            let height = height
                .to_u64()
                .map_err(|e| IndexerError::Invalid(e.to_string()))?;
            if height > ceiling {
                last = Some(ceiling);
                break;
            }
            self.backfill_block(
                height,
                Target {
                    height: scan
                        .finalized_height
                        .to_u64()
                        .map_err(|e| IndexerError::Invalid(e.to_string()))?,
                    hash: at,
                },
                next,
            )
            .await?;
            let current = self.store.coverage(domain).await?;
            if current.as_ref().is_none_or(|c| c.r#gen != generation) {
                return Ok(());
            }
            let committed = current.as_ref().is_some_and(|c| c.contains(height, height));
            if !committed {
                if let Some(start) = cursor
                    && start < height
                {
                    self.finish_range(&scan, start, height - 1).await?;
                }
                cursor = height.checked_add(1);
            }
            last = Some(height);
        }
        // A full replay page proves only its own numeric prefix; remaining winners stay durable.
        let end = if count < 16 { Some(ceiling) } else { last };
        if let (Some(start), Some(end)) = (cursor, end)
            && start <= end
        {
            self.finish_range(&scan, start, end).await?;
        }
        Ok(())
    }
    async fn enumerate_page(&self, scan: &Scan) -> Result<bool, IndexerError> {
        let progress = self
            .store
            .scan_progress(&scan.id)
            .await?
            .ok_or_else(|| IndexerError::Invalid("persisted scan disappeared".into()))?;
        let at = chain_hash(&scan.at);
        if !progress.finished {
            let cursor = progress.cursor.as_ref().map(|key| WinnerCursor {
                at,
                key: key.clone(),
            });
            let page = self.chain.winner_page(at, cursor, PAGE_SIZE).await?;
            if page.at != at
                || (!page.exhausted && page.continuation.is_none())
                || (page.exhausted && page.continuation.is_some())
            {
                return Err(IndexerError::Invalid(
                    "winner page has inconsistent pinned exhaustion".into(),
                ));
            }
            let heights = page.heights.into_iter().map(Into::into).collect::<Vec<_>>();
            let next_cursor = page.continuation.as_ref().map(|c| c.key.as_slice());
            // Hash ordering forbids completing any numeric interval until this is exhausted.
            match check(
                self.store
                    .append_scan_page(&scan.id, progress.cursor.as_deref(), next_cursor, &heights)
                    .await?,
            ) {
                Ok(()) | Err(IndexerError::StaleGeneration) => return Ok(false),
                Err(error) => return Err(error),
            }
        }
        Ok(true)
    }
    async fn finish_range(&self, scan: &Scan, from: u64, through: u64) -> Result<(), IndexerError> {
        let completion = RangeCompletion {
            genesis: scan.genesis.clone(),
            indexable: scan.indexable,
            expected_generation: scan.expected_generation,
            from: from.into(),
            through: through.into(),
            scan_id: scan.id.clone(),
        };
        match check(self.store.commit_range(&completion).await?) {
            Ok(()) | Err(IndexerError::StaleGeneration) => Ok(()),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Indexable, Indexer, Instant, Target, model_hash, uncovered};
    use crate::chain::{BlockHash, ChainReader};
    use dashboard_store::{Store, StoreConfig};
    use std::sync::Arc;

    mod rpc_fixture {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/support/indexer_rpc.rs"
        ));
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "assertions identify sparse retry regressions"
    )]
    async fn permanent_gap_does_not_starve_later_replay_chunks()
    -> Result<(), Box<dyn std::error::Error>> {
        use dashboard_store::{Scan, ScanId};
        use std::sync::atomic::Ordering;
        let (url, fake, server) = rpc_fixture::server().await?;
        fake.replay_winners.store(true, Ordering::SeqCst);
        fake.missing_height.store(2, Ordering::SeqCst);
        let directory = tempfile::tempdir()?;
        let config = StoreConfig::Turso {
            path: directory.path().join("sparse-missing.db"),
        };
        let store = Arc::new(Store::open(config.clone()).await?);
        store
            .bind_network(&model_hash(BlockHash([0; 32])), &[])
            .await?;
        let generation = store.generation(Indexable::Winners).await?;
        let target = Target {
            height: 20,
            hash: BlockHash([20; 32]),
        };
        let scan = Scan {
            id: ScanId("retained-sparse-fixture".into()),
            genesis: model_hash(BlockHash([0; 32])),
            at: model_hash(target.hash),
            finalized_height: target.height.into(),
            indexable: Indexable::Winners,
            expected_generation: generation,
        };
        let _ = store.begin_scan(&scan).await?;
        let heights = (2_u64..=20).map(Into::into).collect::<Vec<_>>();
        let _ = store
            .append_scan_page(&scan.id, None, None, &heights)
            .await?;
        let chain = Arc::new(ChainReader::new(url.clone(), BlockHash([0; 32])));
        chain.connect().await?;
        let (indexer, _) = Indexer::new(store.clone(), chain.clone());
        let mut next = Instant::now();
        indexer
            .sparse_chunk(Indexable::Winners, target, &mut next)
            .await?;
        assert!(
            !store
                .coverage(Indexable::Winners)
                .await?
                .is_some_and(|c| c.contains(20, 20))
        );
        indexer
            .sparse_chunk(Indexable::Winners, target, &mut next)
            .await?;
        let coverage = store
            .coverage(Indexable::Winners)
            .await?
            .ok_or("coverage missing")?;
        assert!(coverage.contains(0, 1));
        assert!(!coverage.contains(2, 2));
        assert!(coverage.contains(3, 20));
        assert_eq!(coverage.gaps, vec![[2, 2]]);
        assert!(
            store
                .get_recent_blocks(1, 0)
                .await?
                .first()
                .is_some_and(|b| b.substrate_block_number.to_u64() == Ok(20))
        );
        for _ in 0..3 {
            indexer
                .sparse_chunk(Indexable::Winners, target, &mut next)
                .await?;
        }
        assert_eq!(
            fake.solution_calls
                .lock()
                .map_err(|_| "calls poisoned")?
                .iter()
                .filter(|n| **n == 2)
                .count(),
            1
        );
        let calls = fake.solution_call_count()?;
        drop(indexer);
        chain.disconnect().await?;
        drop(chain);
        drop(store);
        let store = Arc::new(Store::open(config).await?);
        let chain = Arc::new(ChainReader::new(url, BlockHash([0; 32])));
        chain.connect().await?;
        let (indexer, _) = Indexer::new(store.clone(), chain.clone());
        indexer
            .sparse_chunk(Indexable::Winners, target, &mut Instant::now())
            .await?;
        assert_eq!(fake.solution_call_count()?, calls);
        chain.disconnect().await?;
        server.stop()?;
        Ok(())
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test assertions report generation regressions"
    )]
    async fn selective_reindex_recreates_sparse_coverage_without_reconnect()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        let store = Arc::new(
            Store::open(StoreConfig::Turso {
                path: directory.path().join("reindex.db"),
            })
            .await?,
        );
        store
            .bind_network(&model_hash(BlockHash([0; 32])), &[])
            .await?;
        let _ = store.reindex(&[Indexable::Winners]).await?;
        let chain = Arc::new(ChainReader::new("http://127.0.0.1:1", BlockHash([0; 32])));
        let (indexer, _) = Indexer::new(store.clone(), chain);
        let target = Target {
            height: 3,
            hash: BlockHash([3; 32]),
        };
        let _ = indexer
            .sparse_chunk(Indexable::Winners, target, &mut Instant::now())
            .await;
        let coverage = store
            .coverage(Indexable::Winners)
            .await?
            .ok_or("reindex was never admitted")?;
        assert_eq!(coverage.r#gen, 2);
        assert_eq!(coverage.start, 0);
        assert_eq!(uncovered(&coverage, 3), vec![[0, 3]]);
        Ok(())
    }
    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test assertions report domain pruning isolation"
    )]
    async fn pruned_authorship_does_not_force_full_reads_for_winner_repair()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        let store = Arc::new(
            Store::open(StoreConfig::Turso {
                path: directory.path().join("purpose.db"),
            })
            .await?,
        );
        store
            .bind_network(&model_hash(BlockHash([0; 32])), &[])
            .await?;
        let _ = store
            .initialize_coverage(Indexable::Authorship, 1, 1_u64.into())
            .await?;
        let _ = store
            .set_pruned_floor(
                &dashboard_store::GenerationGuard {
                    indexable: Indexable::Authorship,
                    expected: 1,
                },
                Some(10_u64.into()),
            )
            .await?;
        let chain = Arc::new(ChainReader::new("http://127.0.0.1:1", BlockHash([0; 32])));
        let (indexer, _) = Indexer::new(store.clone(), chain);
        let guards = indexer.guards(3, true).await?;
        assert!(
            guards
                .iter()
                .any(|guard| guard.indexable == Indexable::Winners)
        );
        assert!(
            guards
                .iter()
                .all(|guard| guard.indexable != Indexable::Authorship)
        );
        assert!(
            !store
                .coverage(Indexable::Authorship)
                .await?
                .ok_or("coverage missing")?
                .contains(3, 3)
        );
        Ok(())
    }
}
