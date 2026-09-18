// SPDX-License-Identifier: AGPL-3.0-or-later
//! Restart progress must come from current coverage and matching finalized identity.
use super::*;
use crate::health::{HealthState, Phase, RequiredTask};
use dashboard_store::{
    BlockCommit, BlockRecords, StoreConfig, UnavailableBlock, UnavailableReason,
};
type TestResult = Result<(), Box<dyn std::error::Error>>;

async fn restart(covered: bool) -> TestResult {
    let directory = tempfile::tempdir()?;
    let store = Arc::new(
        Store::open(StoreConfig::Turso {
            path: directory.path().join("restart.db"),
        })
        .await?,
    );
    let genesis = BlockHash([0; 32]);
    let target = Target {
        height: 42,
        hash: BlockHash([42; 32]),
    };
    store.bind_network(&model_hash(genesis), &[]).await?;
    let guard = GenerationGuard {
        indexable: Indexable::Authorship,
        expected: 1,
    };
    if covered {
        let _ = store
            .commit_block(&BlockCommit {
                genesis: model_hash(genesis),
                hash: model_hash(target.hash),
                height: 42.into(),
                guards: vec![guard],
                records: BlockRecords::default(),
                completed: vec![Indexable::Authorship],
            })
            .await?;
    } else {
        let _ = store
            .mark_unavailable(
                &model_hash(genesis),
                &UnavailableBlock {
                    guard: GenerationGuard {
                        indexable: Indexable::Winners,
                        expected: 1,
                    },
                    height: 42.into(),
                    hash: model_hash(target.hash),
                    enrichment_at: model_hash(target.hash),
                    reason: UnavailableReason::MissingRetainedNonce,
                },
            )
            .await?;
    }
    let (indexer, receiver) = Indexer::new(
        Arc::clone(&store),
        Arc::new(ChainReader::new("ws://127.0.0.1:1", genesis)),
    );
    indexer.initialize(target).await?;
    let progress = receiver.borrow().clone();
    assert_eq!(progress.finalized_height, Some(42));
    assert_eq!(progress.committed_height, covered.then_some(42));
    tokio::time::pause();
    let health = HealthState::new(true);
    health.set_phase(Phase::Ready);
    health.connected(true);
    health.head_received(None, progress.finalized_height);
    if let Some(height) = progress.committed_height {
        health.committed(height);
    }
    for tick in 0..10 {
        tokio::time::advance(Duration::from_secs(10)).await;
        health.heartbeat(RequiredTask::Watchdog);
        health.miner_success(&tick.to_string());
    }
    assert_eq!(health.snapshot().ready, covered);
    tokio::time::resume();
    if covered {
        let retained = RetainedBlock {
            height: 42.into(),
            hash: model_hash(target.hash),
        };
        assert!(store.committed_target(&retained).await?);
        let _ = store.reindex(&[Indexable::Authorship]).await?;
        assert!(!store.committed_target(&retained).await?);
        assert!(matches!(
            store
                .committed_target(&RetainedBlock {
                    height: 42.into(),
                    hash: model_hash(BlockHash([43; 32]))
                })
                .await,
            Err(StoreError::ConflictingHistory(_))
        ));
    }
    drop(indexer);
    drop(receiver);
    Arc::try_unwrap(store)
        .map_err(|_| "store still held")?
        .close()
        .await?;
    Ok(())
}
#[tokio::test]
async fn covered_idle_restart_stays_ready() -> TestResult {
    restart(true).await
}
#[tokio::test]
async fn absence_identity_does_not_restore_committed_progress() -> TestResult {
    restart(false).await
}
