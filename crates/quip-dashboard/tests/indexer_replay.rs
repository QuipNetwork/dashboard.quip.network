// SPDX-License-Identifier: AGPL-3.0-or-later
//! Replay through the real chain reader and serialized Turso writer.
use dashboard_model::BlockHash as ModelHash;
use dashboard_store::{Indexable, Store, StoreConfig};
use quip_dashboard::{
    chain::{BlockHash, ChainReader},
    indexer::Indexer,
};
use std::sync::{Arc, atomic::Ordering};

#[path = "support/indexer_rpc.rs"]
mod rpc_fixture;
use rpc_fixture::{hash, server};

type TestResult = Result<(), Box<dyn std::error::Error>>;
#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions report replay regressions"
)]
async fn failed_participation_is_not_completed_and_later_same_block_enrichment_commits()
-> TestResult {
    let (url, fake, server) = server().await?;
    let directory = tempfile::tempdir()?;
    let store = Arc::new(
        Store::open(StoreConfig::Turso {
            path: directory.path().join("replay.db"),
        })
        .await?,
    );
    store.bind_network(&ModelHash::from([0; 32]), &[]).await?;
    let chain = Arc::new(ChainReader::new(url, hash(0)));
    chain.connect().await?;
    let (indexer, progress) = Indexer::new(store.clone(), chain.clone());
    fake.fail_participation.store(true, Ordering::SeqCst);
    indexer.index_finalized(2, hash(3)).await?;
    assert!(
        store
            .coverage(Indexable::Winners)
            .await?
            .is_some_and(|c| c.contains(2, 2))
    );
    assert!(
        store
            .coverage(Indexable::Difficulty)
            .await?
            .is_some_and(|c| c.contains(2, 2))
    );
    assert!(
        store
            .coverage(Indexable::Authorship)
            .await?
            .is_some_and(|c| c.contains(2, 2))
    );
    assert!(store.coverage(Indexable::Participation).await?.is_none());
    let winners = store.get_recent_blocks(10, 0).await?;
    let winner = winners.first().ok_or("winner missing")?;
    assert_eq!(winner.reward.to_string(), u128::MAX.to_string());
    assert!((winner.energy + 1.4).abs() < f64::EPSILON);
    assert_eq!(
        winner.nonce.to_string(),
        "115792089237316195423570985008687907853269984665640564039457584007913129639935"
    );
    assert!(winner.mining_time > 0.0);
    fake.fail_participation.store(false, Ordering::SeqCst);
    indexer.index_finalized(2, hash(3)).await?;
    assert!(
        store
            .coverage(Indexable::Participation)
            .await?
            .is_some_and(|c| c.contains(2, 2)),
        "{:?}",
        progress.borrow().last_error
    );
    assert_eq!(store.get_recent_blocks(10, 0).await?.len(), 1);
    assert_eq!(
        store
            .get_qblock_participation(&winner.qblock_id.to_string())
            .await?
            .len(),
        1
    );
    indexer.index_finalized(2, hash(3)).await?;
    assert_eq!(
        store
            .get_validator_authorship()
            .await?
            .first()
            .ok_or("author missing")?
            .blocks_authored,
        1
    );
    chain.disconnect().await?;
    server.stop()?;
    Ok(())
}

#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions report independent domain regressions"
)]
async fn failed_winner_enrichment_preserves_authorship_and_retries_later() -> TestResult {
    let (url, fake, server) = server().await?;
    let directory = tempfile::tempdir()?;
    let store = Arc::new(
        Store::open(StoreConfig::Turso {
            path: directory.path().join("partial.db"),
        })
        .await?,
    );
    store.bind_network(&ModelHash::from([0; 32]), &[]).await?;
    let chain = Arc::new(ChainReader::new(url, hash(0)));
    chain.connect().await?;
    let (indexer, _) = Indexer::new(store.clone(), chain.clone());
    fake.fail_solution.store(true, Ordering::SeqCst);
    indexer.index_finalized(2, hash(3)).await?;
    assert!(store.coverage(Indexable::Authorship).await?.is_some());
    assert!(store.coverage(Indexable::Winners).await?.is_none());
    assert!(store.coverage(Indexable::Difficulty).await?.is_none());
    fake.fail_solution.store(false, Ordering::SeqCst);
    indexer.index_finalized(2, hash(3)).await?;
    assert_eq!(store.get_recent_blocks(10, 0).await?.len(), 1);
    assert!(store.coverage(Indexable::Difficulty).await?.is_some());
    chain.disconnect().await?;
    server.stop()?;
    Ok(())
}

#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions reject incomplete retained winner coverage"
)]
async fn missing_retained_nonce_leaves_winner_uncovered() -> TestResult {
    let (url, fake, server) = server().await?;
    let directory = tempfile::tempdir()?;
    let store = Arc::new(
        Store::open(StoreConfig::Turso {
            path: directory.path().join("missing.db"),
        })
        .await?,
    );
    store.bind_network(&ModelHash::from([0; 32]), &[]).await?;
    let chain = Arc::new(ChainReader::new(url.clone(), hash(0)));
    chain.connect().await?;
    let (indexer, _) = Indexer::new(store.clone(), chain.clone());
    fake.absent_solution.store(true, Ordering::SeqCst);
    indexer.index_finalized(2, hash(3)).await?;
    assert!(store.get_recent_blocks(10, 0).await?.is_empty());
    assert!(store.coverage(Indexable::Winners).await?.is_none());
    assert!(store.coverage(Indexable::Difficulty).await?.is_none());
    let calls = fake.solution_call_count()?;
    for _ in 0..3 {
        indexer.index_finalized(2, hash(3)).await?;
    }
    assert_eq!(fake.solution_call_count()?, calls);
    for domain in [Indexable::Winners, Indexable::Difficulty] {
        assert!(
            store
                .is_unavailable(domain, store.generation(domain).await?, 2)
                .await?
        );
    }
    for cycle in 1..=2 {
        let _ = store
            .reindex(&[Indexable::Winners, Indexable::Difficulty])
            .await?;
        indexer.index_finalized(2, hash(3)).await?;
        assert_eq!(fake.solution_call_count()?, calls + cycle);
    }
    let calls = fake.solution_call_count()?;
    drop(indexer);
    chain.disconnect().await?;
    drop(chain);
    drop(store);
    let store = Arc::new(
        Store::open(StoreConfig::Turso {
            path: directory.path().join("missing.db"),
        })
        .await?,
    );
    let chain = Arc::new(ChainReader::new(url, hash(0)));
    chain.connect().await?;
    let (indexer, _) = Indexer::new(store.clone(), chain.clone());
    indexer.index_finalized(2, hash(3)).await?;
    assert_eq!(fake.solution_call_count()?, calls);
    fake.absent_solution.store(false, Ordering::SeqCst);
    let _ = store
        .reindex(&[Indexable::Winners, Indexable::Difficulty])
        .await?;
    indexer.index_finalized(2, hash(3)).await?;
    assert_eq!(fake.solution_call_count()?, calls + 1);
    assert_eq!(store.get_recent_blocks(10, 0).await?.len(), 1);
    for domain in [Indexable::Winners, Indexable::Difficulty] {
        assert!(
            store
                .coverage(domain)
                .await?
                .is_some_and(|c| c.contains(2, 2))
        );
    }
    chain.disconnect().await?;
    server.stop()?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires an explicitly supplied disposable loopback PostgreSQL database"]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions report blocked writer pressure"
)]
async fn postgres_pressure_keeps_all_permits_until_database_commit() -> TestResult {
    use sqlx::{
        ConnectOptions, Connection, Executor,
        postgres::{PgConnectOptions, PgConnection},
    };
    use std::{str::FromStr, time::Duration};
    let url = std::env::var("QUIP_INDEXER_TEST_POSTGRES_URL")?;
    let options = PgConnectOptions::from_str(&url)?;
    if options.get_host() != "127.0.0.1"
        || !options
            .get_database()
            .is_some_and(|name| name.starts_with("quip_indexer_pressure_"))
    {
        return Err(
            "pressure test requires a unique quip_indexer_pressure_ database on 127.0.0.1".into(),
        );
    }
    let (endpoint, _, server) = server().await?;
    let store = Arc::new(
        Store::open(StoreConfig::Postgres {
            url,
            max_connections: 8,
        })
        .await?,
    );
    store.bind_network(&ModelHash::from([0; 32]), &[]).await?;
    let chain = Arc::new(ChainReader::new(endpoint, hash(0)));
    chain.connect().await?;
    let (indexer, progress) = Indexer::new(store.clone(), chain.clone());
    let indexer = Arc::new(indexer);
    let mut blocker = PgConnection::connect_with(&options.disable_statement_logging()).await?;
    let mut transaction = blocker.begin().await?;
    let _ = transaction
        .execute("LOCK TABLE blocks IN ACCESS EXCLUSIVE MODE")
        .await?;
    let mut pending = tokio::task::JoinSet::new();
    for _ in 0..64 {
        let indexer = indexer.clone();
        let _ = pending.spawn(async move { indexer.index_finalized(2, hash(3)).await });
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        while progress.borrow().admitted != 64 {
            tokio::task::yield_now().await;
        }
    })
    .await?;
    assert!(indexer.index_finalized(2, hash(3)).await.is_err());
    assert_eq!(progress.borrow().committed_height, None);
    assert!(store.coverage(Indexable::Winners).await?.is_none());
    assert!(
        tokio::time::timeout(Duration::from_millis(100), pending.join_next())
            .await
            .is_err()
    );
    transaction.commit().await?;
    while let Some(result) = pending.join_next().await {
        result??;
    }
    assert_eq!(progress.borrow().admitted, 0);
    assert_eq!(store.get_recent_blocks(10, 0).await?.len(), 1);
    chain.disconnect().await?;
    server.stop()?;
    Ok(())
}

#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions reject writes decoded before reindex"
)]
async fn reindex_during_decode_rejects_the_whole_pending_batch() -> TestResult {
    let (url, fake, server) = server().await?;
    let directory = tempfile::tempdir()?;
    let store = Arc::new(
        Store::open(StoreConfig::Turso {
            path: directory.path().join("decode-reindex.db"),
        })
        .await?,
    );
    store.bind_network(&ModelHash::from([0; 32]), &[]).await?;
    let chain = Arc::new(ChainReader::new(url, hash(0)));
    chain.connect().await?;
    let (indexer, _) = Indexer::new(store.clone(), chain.clone());
    let indexer = Arc::new(indexer);
    fake.hold_solution.store(true, Ordering::SeqCst);
    let pending_indexer = indexer.clone();
    let pending = tokio::spawn(async move { pending_indexer.index_finalized(2, hash(3)).await });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        fake.solution_entered.notified(),
    )
    .await?;
    let _ = store.reindex(&[Indexable::Winners]).await?;
    fake.hold_solution.store(false, Ordering::SeqCst);
    fake.solution_released.notify_one();
    assert!(matches!(
        pending.await?,
        Err(quip_dashboard::indexer::IndexerError::StaleGeneration)
    ));
    assert!(store.get_recent_blocks(10, 0).await?.is_empty());
    assert!(store.get_validator_authorship().await?.is_empty());
    indexer.index_finalized(2, hash(3)).await?;
    assert_eq!(store.get_recent_blocks(10, 0).await?.len(), 1);
    assert_eq!(
        store
            .coverage(Indexable::Winners)
            .await?
            .ok_or("coverage missing")?
            .r#gen,
        2
    );
    chain.disconnect().await?;
    server.stop()?;
    Ok(())
}
