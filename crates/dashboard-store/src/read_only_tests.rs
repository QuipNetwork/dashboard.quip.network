// SPDX-License-Identifier: AGPL-3.0-or-later
//! Postgres API-only reads alongside the owning indexer.
#![expect(
    clippy::panic_in_result_fn,
    reason = "Test assertions report failures while Result propagates setup errors"
)]
use crate::{
    AuthorshipRecord, BlockCommit, BlockRecords, GenerationGuard, Indexable, Store, StoreConfig,
    StoreError,
};
use sqlx::Connection as _;
use std::error::Error;

async fn database_url() -> Result<String, Box<dyn Error>> {
    let base = std::env::var("STORE_TEST_POSTGRES_URL")?;
    let mut admin = sqlx::PgConnection::connect(&base).await?;
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let name = format!("store_read_only_{suffix}");
    let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
        .execute(&mut admin)
        .await?;
    Ok(format!(
        "{}/{name}",
        base.rsplit_once('/').ok_or("database URL")?.0
    ))
}

fn read_only<T>(result: &Result<T, StoreError>) -> Result<(), Box<dyn Error>> {
    let Err(StoreError::ReadOnly) = result else {
        return Err("expected explicit read-only rejection".into());
    };
    Ok(())
}

#[tokio::test]
#[ignore = "requires STORE_TEST_POSTGRES_URL pointing to disposable local Postgres"]
async fn api_only_reader_coexists_with_writer_and_rejects_mutation() -> Result<(), Box<dyn Error>> {
    let url = database_url().await?;
    let config = StoreConfig::Postgres {
        url: url.clone(),
        max_connections: 2,
    };
    let writer = Store::open(config.clone()).await?;
    let genesis = format!("0x{:064x}", 0).parse()?;
    writer.bind_network(&genesis, &[]).await?;
    writer.set_self_address(Some("writer")).await?;
    let batch = BlockCommit {
        genesis: genesis.clone(),
        hash: format!("0x{:064x}", 42).parse()?,
        height: 42.into(),
        guards: vec![GenerationGuard {
            indexable: Indexable::Authorship,
            expected: 1,
        }],
        records: BlockRecords {
            authorship: Some(AuthorshipRecord {
                account_id: "alice".into(),
                block_number: 42.into(),
                timestamp: 1_700_000_000,
                had_winner: true,
            }),
            ..BlockRecords::default()
        },
        completed: vec![Indexable::Authorship],
    };
    let _ = writer.commit_block(&batch).await?;
    let reader = Store::open_read_only_postgres(&url, 2).await?;
    assert_eq!(reader.get_self_address().await?.as_deref(), Some("writer"));
    assert_eq!(reader.bound_genesis().await?, Some(genesis.clone()));
    let authors = reader.get_validator_authorship().await?;
    let author = authors.first().ok_or("missing author")?;
    assert_eq!(author.account_id, "alice");
    assert_eq!(author.blocks_authored, 1);
    let setting = reader
        .query(
            "SELECT current_setting('transaction_read_only') AS value",
            &[],
        )
        .await?;
    assert_eq!(
        crate::backend::text(setting.first().ok_or("setting")?, "value")?,
        "on"
    );
    read_only(&reader.set_self_address(Some("reader")).await)?;
    read_only(&reader.bind_network(&genesis, &[]).await)?;
    read_only(&reader.reindex(&[]).await)?;
    read_only(&reader.commit_block(&batch).await)?;
    read_only(&reader.upsert_chain_miners(&[]).await)?;
    read_only(&reader.recompute_authorship_summary().await)?;
    read_only(&reader.try_authorship_cutover().await)?;
    assert_eq!(writer.get_self_address().await?.as_deref(), Some("writer"));
    let Err(StoreError::WriterOwned) = Store::open(config).await else {
        return Err("second writer acquired lease".into());
    };
    writer.set_self_address(Some("updated")).await?;
    assert_eq!(reader.get_self_address().await?.as_deref(), Some("updated"));
    reader.close().await?;
    writer.set_self_address(Some("still-owned")).await?;
    writer.close().await?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires STORE_TEST_POSTGRES_URL pointing to disposable local Postgres"]
async fn api_only_requires_current_schema_without_applying_migrations() -> Result<(), Box<dyn Error>>
{
    let url = database_url().await?;
    let mut connection = sqlx::PgConnection::connect(&url).await?;
    let result = Store::open_read_only_postgres(&url, 2).await;
    let Err(StoreError::MigrationHistory(message)) = result else {
        return Err("missing schema accepted".into());
    };
    assert!(message.contains("migrate up"));
    let exists: bool = sqlx::query_scalar("SELECT to_regclass('kysely_migration') IS NOT NULL")
        .fetch_one(&mut connection)
        .await?;
    assert!(!exists);
    let _ = sqlx::raw_sql("CREATE TABLE kysely_migration(name TEXT PRIMARY KEY, timestamp TEXT NOT NULL); INSERT INTO kysely_migration VALUES('0001_initial','old')").execute(&mut connection).await?;
    let result = Store::open_read_only_postgres(&url, 2).await;
    let Err(StoreError::MigrationHistory(message)) = result else {
        return Err("pending schema accepted".into());
    };
    assert!(message.contains("0002_telemetry_sort_indexes"));
    assert!(message.contains("migrate up"));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM kysely_migration")
        .fetch_one(&mut connection)
        .await?;
    assert_eq!(count, 1);
    let exists: bool = sqlx::query_scalar("SELECT to_regclass('dashboard_finalized') IS NOT NULL")
        .fetch_one(&mut connection)
        .await?;
    assert!(!exists);
    Ok(())
}
