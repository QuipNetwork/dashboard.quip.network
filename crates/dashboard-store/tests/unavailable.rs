// SPDX-License-Identifier: AGPL-3.0-or-later
//! Durable absence changes retry planning, never completed coverage.
use dashboard_model::BlockHash;
use dashboard_store::{
    CommitResult, GenerationGuard, Indexable, Store, StoreConfig, UnavailableBlock,
    UnavailableReason,
};

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn marker(height: u64, expected: u64, reason: UnavailableReason) -> UnavailableBlock {
    UnavailableBlock {
        guard: GenerationGuard {
            indexable: match reason {
                UnavailableReason::MissingRetainedNonce => Indexable::Winners,
                UnavailableReason::MissingRetainedDifficulty => Indexable::Difficulty,
            },
            expected,
        },
        height: height.into(),
        hash: BlockHash::from([1; 32]),
        enrichment_at: BlockHash::from([2; 32]),
        reason,
    }
}

async fn scenario(store: &Store) -> TestResult {
    let genesis = BlockHash::from([0; 32]);
    store.bind_network(&genesis, &[]).await?;
    let generation = store.generation(Indexable::Winners).await?;
    for height in [0, 1, 2, 9, 10, u64::MAX - 1, u64::MAX] {
        let absence = marker(height, generation, UnavailableReason::MissingRetainedNonce);
        assert_eq!(
            store.mark_unavailable(&genesis, &absence).await?,
            CommitResult::Applied
        );
        assert_eq!(
            store.mark_unavailable(&genesis, &absence).await?,
            CommitResult::AlreadyApplied
        );
    }
    assert!(store.coverage(Indexable::Winners).await?.is_none());
    for (from, through, expected) in [
        (0, 2, None),
        (0, 20, Some([3, 8])),
        (3, 20, Some([3, 8])),
        (9, 20, Some([11, 20])),
        (u64::MAX - 2, u64::MAX, Some([u64::MAX - 2, u64::MAX - 2])),
        (u64::MAX - 1, u64::MAX, None),
        (u64::MAX, u64::MAX, None),
    ] {
        assert_eq!(
            store
                .retryable_range(Indexable::Winners, generation, from, through)
                .await?,
            expected
        );
    }
    assert_eq!(
        store
            .retryable_range(Indexable::Participation, generation, 0, 20)
            .await?,
        Some([0, 20])
    );
    let mut conflict = marker(1, generation, UnavailableReason::MissingRetainedNonce);
    conflict.hash = BlockHash::from([9; 32]);
    assert!(store.mark_unavailable(&genesis, &conflict).await.is_err());
    let difficulty = marker(
        1,
        store.generation(Indexable::Difficulty).await?,
        UnavailableReason::MissingRetainedDifficulty,
    );
    assert_eq!(
        store.mark_unavailable(&genesis, &difficulty).await?,
        CommitResult::Applied
    );
    let _ = store.reindex(&[Indexable::Winners]).await?;
    assert!(
        !store
            .is_unavailable(Indexable::Winners, generation, 1)
            .await?
    );
    assert!(
        store
            .is_unavailable(Indexable::Difficulty, difficulty.guard.expected, 1)
            .await?
    );
    assert_eq!(
        store
            .mark_unavailable(
                &genesis,
                &marker(3, generation, UnavailableReason::MissingRetainedNonce)
            )
            .await?,
        CommitResult::StaleGeneration
    );
    let current = store.generation(Indexable::Winners).await?;
    assert_eq!(
        store
            .retryable_range(Indexable::Winners, current, 0, u64::MAX)
            .await?,
        Some([0, u64::MAX])
    );
    Ok(())
}

#[tokio::test]
async fn turso_absence_planning_and_reindex() -> TestResult {
    let directory = tempfile::tempdir()?;
    let store = Store::open(StoreConfig::Turso {
        path: directory.path().join("unavailable.db"),
    })
    .await?;
    scenario(&store).await
}

#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "assertions identify restart regressions"
)]
async fn restart_keeps_absence_without_coverage() -> TestResult {
    let directory = tempfile::tempdir()?;
    let config = StoreConfig::Turso {
        path: directory.path().join("restart.db"),
    };
    let generation;
    {
        let store = Store::open(config.clone()).await?;
        let genesis = BlockHash::from([0; 32]);
        store.bind_network(&genesis, &[]).await?;
        generation = store.generation(Indexable::Winners).await?;
        let _ = store
            .mark_unavailable(
                &genesis,
                &marker(7, generation, UnavailableReason::MissingRetainedNonce),
            )
            .await?;
    }
    let store = Store::open(config).await?;
    assert!(
        store
            .is_unavailable(Indexable::Winners, generation, 7)
            .await?
    );
    assert_eq!(
        store
            .retryable_range(Indexable::Winners, generation, 7, 8)
            .await?,
        Some([8, 8])
    );
    assert!(store.coverage(Indexable::Winners).await?.is_none());
    Ok(())
}

#[cfg(feature = "postgres")]
#[tokio::test]
#[ignore = "requires STORE_TEST_POSTGRES_URL pointing to disposable loopback Postgres"]
async fn postgres_absence_planning_and_reindex() -> TestResult {
    use sqlx::{Connection as _, postgres::PgConnectOptions};
    use std::str::FromStr as _;
    let base = std::env::var("STORE_TEST_POSTGRES_URL")?;
    let options = PgConnectOptions::from_str(&base)?;
    if options.get_host() != "127.0.0.1" {
        return Err("test requires loopback PostgreSQL".into());
    }
    let mut admin = sqlx::PgConnection::connect(&base).await?;
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let name = format!("store_unavailable_{suffix}");
    let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
        .execute(&mut admin)
        .await?;
    let url = format!(
        "{}/{name}",
        base.rsplit_once('/').ok_or("test database URL")?.0
    );
    let store = Store::open(StoreConfig::Postgres {
        url,
        max_connections: 2,
    })
    .await?;
    let result = scenario(&store).await;
    drop(store);
    let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "DROP DATABASE {name} WITH (FORCE)"
    )))
    .execute(&mut admin)
    .await?;
    result
}
