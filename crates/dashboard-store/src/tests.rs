// SPDX-License-Identifier: AGPL-3.0-or-later
//! Engine-level transaction cancellation and retained history tests.
use crate::{Store, StoreConfig};
use std::{error::Error, sync::Arc};

#[expect(
    clippy::too_many_lines,
    reason = "This scenario verifies ownership and rollback across a complete database reopen"
)]
async fn transaction_safety(config: StoreConfig) -> Result<(), Box<dyn Error>> {
    let store = Arc::new(Store::open(config.clone()).await?);
    assert!(Store::open(config.clone()).await.is_err());
    let genesis = format!("0x{:064x}", 0).parse()?;
    let retained_hash = format!("0x{:064x}", 9).parse()?;
    {
        let mut tx = store.write().await?;
        let _ = tx
            .conn()
            .execute(
                "INSERT INTO dashboard_finalized(height,hash) VALUES('9',?1)",
                &[format!("{retained_hash}").into()],
            )
            .await?;
        tx.commit().await?;
    }
    assert!(store.bind_network(&genesis, &[]).await.is_err());
    let evidence = crate::RetainedBlock {
        height: 9.into(),
        hash: retained_hash,
    };
    store.bind_network(&genesis, &[evidence]).await?;
    let scan = crate::Scan {
        id: crate::ScanId("restart-scan".into()),
        genesis: genesis.clone(),
        at: format!("0x{:064x}", 50).parse()?,
        finalized_height: 50.into(),
        indexable: crate::Indexable::Winners,
        expected_generation: 1,
    };
    let _ = store.begin_scan(&scan).await?;
    let _ = store
        .append_scan_page(&scan.id, None, Some(&[8]), &[42.into(), 9.into()])
        .await?;
    let worker_store = Arc::clone(&store);
    let (started, ready) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let mut tx = worker_store.write().await?;
        let _ = tx
            .conn()
            .execute(
                "INSERT INTO meta(key,value) VALUES('cancelled','must-rollback')",
                &[],
            )
            .await?;
        let _ = started.send(());
        std::future::pending::<()>().await;
        tx.commit().await
    });
    ready.await?;
    task.abort();
    assert!(task.await.is_err());
    store.set_self_address(Some("survives")).await?;
    assert!(store.meta("cancelled").await?.is_none());
    // A real SQL constraint failure after an earlier mutation must roll back both.
    {
        let mut tx = store.write().await?;
        let _ = tx
            .conn()
            .execute(
                "INSERT INTO meta(key,value) VALUES('rolled-back','first-write')",
                &[],
            )
            .await?;
        assert!(
            tx.conn()
                .execute(
                    "INSERT INTO meta(key,value) VALUES('self_address','constraint-failure')",
                    &[]
                )
                .await
                .is_err()
        );
    }
    store.set_self_address(Some("survives")).await?;
    assert!(store.meta("rolled-back").await?.is_none());
    // Preserve aggregate floors while new authored facts catch up.
    {
        let mut tx = store.write().await?;
        tx.conn().batch("INSERT INTO validator_authorship VALUES('old',2,1,99,'2020-01-01T00:00:00.000Z'); INSERT INTO validator_authorship_blocks VALUES('old',100,'2020-01-01T00:01:00.000Z',TRUE)").await?;
        tx.commit().await?;
    }
    assert!(!store.try_authorship_cutover().await?);
    assert_eq!(
        store
            .get_validator_authorship()
            .await?
            .first()
            .ok_or("floor")?
            .blocks_authored,
        2
    );
    {
        let mut tx = store.write().await?;
        tx.conn().batch("INSERT INTO validator_authorship_blocks VALUES('old',101,'2020-01-01T00:02:00.000Z',FALSE)").await?;
        tx.commit().await?;
    }
    assert!(store.try_authorship_cutover().await?);
    drop(store);
    let reopened = Store::open(config).await?;
    assert_eq!(
        reopened.get_self_address().await?.as_deref(),
        Some("survives")
    );
    assert!(reopened.is_authorship_cutover().await?);
    assert!(reopened.meta("cancelled").await?.is_none());
    let progress = reopened
        .scan_progress(&scan.id)
        .await?
        .ok_or("scan progress")?;
    assert_eq!(progress.cursor, Some(vec![8]));
    assert!(!progress.finished);
    assert_eq!(
        reopened.scan_winners(&scan.id, None, 1).await?,
        vec![9.into()]
    );
    assert_eq!(
        reopened.scan_winners(&scan.id, Some(9.into()), 1).await?,
        vec![42.into()]
    );
    let range = crate::RangeCompletion {
        genesis,
        indexable: crate::Indexable::Winners,
        expected_generation: 1,
        from: 0.into(),
        through: 50.into(),
        scan_id: scan.id.clone(),
    };
    assert!(reopened.commit_range(&range).await.is_err());
    let _ = reopened
        .append_scan_page(&scan.id, Some(&[8]), None, &[])
        .await?;
    assert!(reopened.commit_range(&range).await.is_err());
    let empty_range = crate::RangeCompletion {
        from: 43.into(),
        ..range
    };
    assert_eq!(
        reopened.commit_range(&empty_range).await?,
        crate::CommitResult::Applied
    );
    let guard = crate::GenerationGuard {
        indexable: crate::Indexable::Winners,
        expected: 1,
    };
    let _ = reopened.set_pruned_floor(&guard, Some(40.into())).await?;
    assert!(
        !reopened
            .coverage(crate::Indexable::Winners)
            .await?
            .ok_or("coverage")?
            .contains(0, 40)
    );
    let _ = reopened.set_pruned_floor(&guard, None).await?;
    let _ = reopened.reindex(&[crate::Indexable::Winners]).await?;
    assert_eq!(
        reopened.commit_range(&empty_range).await?,
        crate::CommitResult::StaleGeneration
    );
    Ok(())
}

#[tokio::test]
async fn turso_transaction_safety() -> Result<(), Box<dyn Error>> {
    let dir = tempfile::tempdir()?;
    transaction_safety(StoreConfig::Turso {
        path: dir.path().join("transactions.db"),
    })
    .await
}

#[expect(
    clippy::too_many_lines,
    reason = "Verify binding retries and shutdown against the same retained database"
)]
async fn binding_lifecycle(config: StoreConfig) -> Result<(), Box<dyn Error>> {
    let store = Store::open(config.clone()).await?;
    let genesis: dashboard_model::BlockHash = format!("0x{:064x}", 0).parse()?;
    assert_eq!(store.bound_genesis().await?, None);
    {
        let mut tx = store.write().await?;
        tx.conn().batch("INSERT INTO validator_authorship VALUES('unverifiable',1,0,9,'2020-01-01T00:00:00.000Z')").await?;
        tx.commit().await?;
    }
    assert!(store.bind_network(&genesis, &[]).await.is_err());
    {
        let mut tx = store.write().await?;
        tx.conn().batch("DELETE FROM validator_authorship").await?;
        for height in 1_u64..=1025 {
            let _ = tx
                .conn()
                .execute(
                    "INSERT INTO dashboard_finalized(height,hash) VALUES(?1,?2)",
                    &[height.to_string().into(), format!("0x{height:064x}").into()],
                )
                .await?;
        }
        tx.commit().await?;
    }
    let mut verified = 0_u64;
    let reader = &store;
    let result = store
        .bind_network_with(&genesis, |row| {
            verified += 1;
            let current = verified;
            async move {
                if current == 1 && reader.pg() {
                    // Upstream verification must not keep a Postgres transaction open.
                    assert!(reader.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND state LIKE '%transaction%'", &[]).await?.is_empty());
                }
                if current == 513 {
                    Err(crate::StoreError::VerificationUnavailable(
                        "retry upstream".into(),
                    ))
                } else {
                    Ok(row.hash)
                }
            }
        })
        .await;
    let Err(crate::StoreError::VerificationUnavailable(_)) = result else {
        return Err("expected temporary verification failure".into());
    };
    assert_eq!(verified, 513);
    assert_eq!(store.bound_genesis().await?, None);
    let mismatch = store
        .bind_network_with(&genesis, |_| std::future::ready(Ok(genesis.clone())))
        .await;
    let Err(crate::StoreError::NetworkIdentity) = mismatch else {
        return Err("expected retained hash mismatch".into());
    };
    assert_eq!(store.bound_genesis().await?, None);
    let mut observed = 0;
    let (started, ready) = tokio::sync::oneshot::channel();
    let mut started = Some(started);
    tokio::select! {
        result = store.bind_network_with(&genesis, |row| {
            observed += 1;
            let started = started.take();
            async move {
                if let Some(started) = started { let _ = started.send(()); }
                std::future::pending::<()>().await;
                Ok(row.hash)
            }
        }) => return Err(format!("verification unexpectedly finished: {result:?}").into()),
        result = ready => result?,
    }
    assert_eq!(observed, 1);
    assert_eq!(store.bound_genesis().await?, None);
    verified = 0;
    store
        .bind_network_with(&genesis, |row| {
            verified += 1;
            assert_eq!(row.height, verified.into());
            std::future::ready(Ok(row.hash))
        })
        .await?;
    assert_eq!(verified, 1025);
    assert_eq!(store.bound_genesis().await?, Some(genesis.clone()));
    store
        .bind_network_with(&genesis, |_| {
            std::future::ready(Err(crate::StoreError::NetworkIdentity))
        })
        .await?;
    store.set_self_address(Some("persisted")).await?;
    // Model a cancelled worker whose transaction guard drops after writing.
    {
        let mut tx = store.write().await?;
        let _ = tx
            .conn()
            .execute(
                "INSERT INTO meta(key,value) VALUES('cancel-at-shutdown','discard')",
                &[],
            )
            .await?;
    }
    store.close().await?;
    let reopened = Store::open(config).await?;
    assert_eq!(reopened.bound_genesis().await?, Some(genesis));
    assert_eq!(
        reopened.get_self_address().await?.as_deref(),
        Some("persisted")
    );
    assert_eq!(reopened.meta("cancel-at-shutdown").await?, None);
    let _ = reopened.reindex(&[crate::Indexable::Winners]).await?;
    assert_eq!(reopened.generation(crate::Indexable::Winners).await?, 2);
    reopened.close().await?;
    Ok(())
}

#[tokio::test]
async fn turso_binding_lifecycle() -> Result<(), Box<dyn Error>> {
    let directory = tempfile::tempdir()?;
    binding_lifecycle(StoreConfig::Turso {
        path: directory.path().join("binding.db"),
    })
    .await
}

#[cfg(feature = "postgres")]
#[tokio::test]
#[ignore = "requires STORE_TEST_POSTGRES_URL pointing to disposable local Postgres"]
async fn postgres_transaction_safety() -> Result<(), Box<dyn Error>> {
    use sqlx::Connection as _;
    let base = std::env::var("STORE_TEST_POSTGRES_URL")?;
    let mut admin = sqlx::PgConnection::connect(&base).await?;
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let name = format!("store_transactions_{suffix}");
    let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
        .execute(&mut admin)
        .await?;
    let url = format!(
        "{}/{name}",
        base.rsplit_once('/').ok_or("test database URL")?.0
    );
    transaction_safety(StoreConfig::Postgres {
        url,
        max_connections: 2,
    })
    .await
}

#[cfg(feature = "postgres")]
#[tokio::test]
#[ignore = "requires STORE_TEST_POSTGRES_URL pointing to disposable local Postgres"]
async fn postgres_binding_lifecycle() -> Result<(), Box<dyn Error>> {
    use sqlx::Connection as _;
    let base = std::env::var("STORE_TEST_POSTGRES_URL")?;
    let mut admin = sqlx::PgConnection::connect(&base).await?;
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let name = format!("store_binding_{suffix}");
    let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
        .execute(&mut admin)
        .await?;
    let url = format!(
        "{}/{name}",
        base.rsplit_once('/').ok_or("test database URL")?.0
    );
    binding_lifecycle(StoreConfig::Postgres {
        url,
        max_connections: 2,
    })
    .await
}
