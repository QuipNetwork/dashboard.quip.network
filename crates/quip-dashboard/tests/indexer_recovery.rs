// SPDX-License-Identifier: AGPL-3.0-or-later
//! Durable scheduling state survives replay, reindex, and incomplete enumeration.
use dashboard_model::BlockHash;
use dashboard_store::{
    AuthorshipRecord, BlockCommit, BlockRecords, CommitResult, Coverage, GenerationGuard,
    Indexable, RangeCompletion, Scan, ScanId, Store, StoreConfig, StoreError,
};
use quip_dashboard::indexer::coverage::{subtract_points, uncovered};
type TestResult = Result<(), Box<dyn std::error::Error>>;
fn hash(height: u8) -> BlockHash {
    BlockHash::from([height; 32])
}
fn block(height: u8, generation: u64) -> BlockCommit {
    BlockCommit {
        genesis: hash(0),
        hash: hash(height),
        height: u64::from(height).into(),
        guards: vec![GenerationGuard {
            indexable: Indexable::Authorship,
            expected: generation,
        }],
        records: BlockRecords {
            authorship: Some(AuthorshipRecord {
                account_id: "validator".into(),
                block_number: u64::from(height).into(),
                timestamp: 100 + u64::from(height),
                had_winner: false,
            }),
            ..BlockRecords::default()
        },
        completed: vec![Indexable::Authorship],
    }
}
#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions report recovery regressions"
)]
async fn restart_retains_out_of_order_gaps_and_never_replays_authorship_from_genesis() -> TestResult
{
    let directory = tempfile::tempdir()?;
    let config = StoreConfig::Turso {
        path: directory.path().join("restart.db"),
    };
    {
        let store = Store::open(config.clone()).await?;
        store.bind_network(&hash(0), &[]).await?;
        let _ = store
            .initialize_coverage(Indexable::Authorship, 1, 10_u64.into())
            .await?;
        for height in [12, 10, 12] {
            let _ = store.commit_block(&block(height, 1)).await?;
        }
        assert_eq!(
            store
                .get_validator_authorship()
                .await?
                .first()
                .ok_or("author missing")?
                .blocks_authored,
            2
        );
    }
    let store = Store::open(config).await?;
    let _ = store
        .initialize_coverage(Indexable::Authorship, 1, 99_u64.into())
        .await?;
    let coverage = store
        .coverage(Indexable::Authorship)
        .await?
        .ok_or("coverage missing")?;
    assert_eq!(uncovered(&coverage, 14), vec![[11, 11], [13, 14]]);
    assert_eq!(coverage.start, 10);
    let _ = store.commit_block(&block(11, 1)).await?;
    assert_eq!(
        uncovered(
            &store
                .coverage(Indexable::Authorship)
                .await?
                .ok_or("coverage missing")?,
            14
        ),
        vec![[13, 14]]
    );
    Ok(())
}
#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions report stale generation writes"
)]
async fn stale_generation_writes_no_records_or_coverage() -> TestResult {
    let directory = tempfile::tempdir()?;
    let store = Store::open(StoreConfig::Turso {
        path: directory.path().join("stale.db"),
    })
    .await?;
    store.bind_network(&hash(0), &[]).await?;
    let pending = block(10, 1);
    let _ = store.reindex(&[Indexable::Authorship]).await?;
    assert_eq!(
        store.commit_block(&pending).await?,
        CommitResult::StaleGeneration
    );
    assert!(store.get_validator_authorship().await?.is_empty());
    assert!(store.coverage(Indexable::Authorship).await?.is_none());
    assert_eq!(
        store.commit_block(&block(10, 2)).await?,
        CommitResult::Applied
    );
    Ok(())
}
#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions report false empty-range completion"
)]
async fn restart_cannot_complete_a_partial_hash_ordered_scan_or_an_uncommitted_winner() -> TestResult
{
    let directory = tempfile::tempdir()?;
    let config = StoreConfig::Turso {
        path: directory.path().join("scan.db"),
    };
    let scan = Scan {
        id: ScanId("pinned".into()),
        genesis: hash(0),
        at: hash(20),
        finalized_height: 20_u64.into(),
        indexable: Indexable::Winners,
        expected_generation: 1,
    };
    let range = RangeCompletion {
        genesis: hash(0),
        indexable: Indexable::Winners,
        expected_generation: 1,
        from: 0_u64.into(),
        through: 20_u64.into(),
        scan_id: scan.id.clone(),
    };
    {
        let store = Store::open(config.clone()).await?;
        store.bind_network(&hash(0), &[]).await?;
        let _ = store.begin_scan(&scan).await?;
        let _ = store
            .append_scan_page(&scan.id, None, Some(&[10]), &[18_u64.into()])
            .await?;
        assert!(matches!(
            store.commit_range(&range).await,
            Err(StoreError::IncompleteScan)
        ));
    }
    let store = Store::open(config).await?;
    assert_eq!(
        store
            .scan_progress(&scan.id)
            .await?
            .ok_or("scan missing")?
            .cursor,
        Some(vec![10])
    );
    let _ = store
        .append_scan_page(&scan.id, Some(&[10]), None, &[3_u64.into()])
        .await?;
    assert!(matches!(
        store.commit_range(&range).await,
        Err(StoreError::IncompleteScan)
    ));
    assert_eq!(
        store.scan_winners(&scan.id, None, 2).await?,
        vec![3_u64.into(), 18_u64.into()]
    );
    for height in [18, 3] {
        let batch = BlockCommit {
            genesis: hash(0),
            hash: hash(height),
            height: u64::from(height).into(),
            guards: vec![GenerationGuard {
                indexable: Indexable::Winners,
                expected: 1,
            }],
            records: BlockRecords::default(),
            completed: vec![Indexable::Winners],
        };
        let _ = store.commit_block(&batch).await?;
    }
    let _ = store.commit_range(&range).await?;
    assert!(
        store
            .coverage(Indexable::Winners)
            .await?
            .ok_or("coverage missing")?
            .contains(0, 20)
    );
    Ok(())
}
#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions report pruning coverage regressions"
)]
async fn pruned_floor_suppresses_work_but_startup_reprobe_restores_uncovered_range() -> TestResult {
    let directory = tempfile::tempdir()?;
    let store = Store::open(StoreConfig::Turso {
        path: directory.path().join("pruned.db"),
    })
    .await?;
    store.bind_network(&hash(0), &[]).await?;
    let guard = GenerationGuard {
        indexable: Indexable::Winners,
        expected: 1,
    };
    let _ = store
        .initialize_coverage(Indexable::Winners, 1, 0_u64.into())
        .await?;
    let _ = store.set_pruned_floor(&guard, Some(50_u64.into())).await?;
    let coverage = store
        .coverage(Indexable::Winners)
        .await?
        .ok_or("coverage missing")?;
    assert_eq!(uncovered(&coverage, 100), vec![[51, 100]]);
    assert!(!coverage.contains(0, 50));
    let _ = store.set_pruned_floor(&guard, None).await?;
    assert_eq!(
        uncovered(
            &store
                .coverage(Indexable::Winners)
                .await?
                .ok_or("coverage missing")?,
            100
        ),
        vec![[0, 100]]
    );
    Ok(())
}
#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions report changed genesis writes"
)]
async fn changed_genesis_is_rejected_before_writes() -> TestResult {
    let directory = tempfile::tempdir()?;
    let store = Store::open(StoreConfig::Turso {
        path: directory.path().join("genesis.db"),
    })
    .await?;
    store.bind_network(&hash(0), &[]).await?;
    let mut batch = block(10, 1);
    batch.genesis = hash(99);
    assert!(matches!(
        store.commit_block(&batch).await,
        Err(StoreError::NetworkIdentity)
    ));
    assert!(store.get_validator_authorship().await?.is_empty());
    Ok(())
}
#[test]
fn failed_winners_remain_gaps_in_an_otherwise_proven_empty_range() {
    assert_eq!(
        subtract_points([0, 20], &[18, 3, 3]),
        vec![[0, 2], [4, 17], [19, 20]]
    );
    let mut coverage = Coverage::empty(1, 0);
    coverage.pruned_floor = Some(u64::MAX);
    assert!(uncovered(&coverage, u64::MAX).is_empty());
}
