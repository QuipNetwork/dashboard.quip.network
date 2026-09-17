// SPDX-License-Identifier: AGPL-3.0-or-later
//! Read-only operator migration inspection against real engines.
#![expect(
    clippy::panic_in_result_fn,
    reason = "Assertions report test failures while Result propagates database setup errors"
)]
use dashboard_store::{Store, StoreConfig, StoreError};
use std::{error::Error, ffi::OsString, path::Path, time::SystemTime};

type FileSnapshot = Vec<(OsString, Vec<u8>, SystemTime)>;

fn snapshot(directory: &Path) -> Result<FileSnapshot, Box<dyn Error>> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        files.push((
            entry.file_name(),
            std::fs::read(entry.path())?,
            entry.metadata()?.modified()?,
        ));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(files)
}

#[tokio::test]
async fn turso_inspection_never_changes_files() -> Result<(), Box<dyn Error>> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("inspect.db");
    let config = StoreConfig::Turso { path: path.clone() };
    let before = snapshot(directory.path())?;
    let missing = Store::inspect_migrations(config.clone()).await?;
    assert_eq!(missing.len(), 9);
    assert!(missing.iter().all(|row| row.executed_at.is_none()));
    assert_eq!(before, snapshot(directory.path())?);
    let database = turso::Builder::new_local(path.to_str().ok_or("path")?)
        .with_io("syscall".into())
        .build()
        .await?;
    let connection = database.connect()?;
    connection
        .execute_batch("CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('data')")
        .await?;
    let without_ledger = snapshot(directory.path())?;
    assert!(
        Store::inspect_migrations(config.clone())
            .await?
            .iter()
            .all(|row| row.executed_at.is_none())
    );
    assert_eq!(without_ledger, snapshot(directory.path())?);
    connection.execute_batch("CREATE TABLE kysely_migration(name TEXT PRIMARY KEY, timestamp TEXT NOT NULL); INSERT INTO kysely_migration VALUES('0001_initial','2020-01-01T00:00:00.000Z')").await?;
    let live = snapshot(directory.path())?;
    let rows = Store::inspect_migrations(config.clone()).await?;
    assert_eq!(
        rows.first().and_then(|row| row.executed_at.as_deref()),
        Some("2020-01-01T00:00:00.000Z")
    );
    assert_eq!(
        rows.iter().filter(|row| row.executed_at.is_none()).count(),
        8
    );
    assert_eq!(live, snapshot(directory.path())?);
    drop(connection);
    drop(database);
    let closed = snapshot(directory.path())?;
    let rows = Store::inspect_migrations(config).await?;
    assert_eq!(
        rows.iter().filter(|row| row.executed_at.is_some()).count(),
        1
    );
    assert_eq!(closed, snapshot(directory.path())?);
    Ok(())
}

#[tokio::test]
async fn turso_inspection_rejects_unknown_and_gapped_ledgers() -> Result<(), Box<dyn Error>> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("invalid.db");
    let database = turso::Builder::new_local(path.to_str().ok_or("path")?)
        .with_io("syscall".into())
        .build()
        .await?;
    let connection = database.connect()?;
    connection.execute_batch("CREATE TABLE kysely_migration(name TEXT PRIMARY KEY, timestamp TEXT NOT NULL); INSERT INTO kysely_migration VALUES('unknown','old')").await?;
    let config = StoreConfig::Turso { path };
    let before = snapshot(directory.path())?;
    let result = Store::inspect_migrations(config.clone()).await;
    let Err(StoreError::MigrationHistory(_)) = result else {
        return Err("unknown migration accepted".into());
    };
    assert_eq!(before, snapshot(directory.path())?);
    connection.execute_batch("DELETE FROM kysely_migration; INSERT INTO kysely_migration VALUES('0002_telemetry_sort_indexes','old')").await?;
    let before = snapshot(directory.path())?;
    let result = Store::inspect_migrations(config).await;
    let Err(StoreError::MigrationHistory(_)) = result else {
        return Err("gapped migration history accepted".into());
    };
    assert_eq!(before, snapshot(directory.path())?);
    Ok(())
}

#[cfg(feature = "postgres")]
#[tokio::test]
#[ignore = "requires STORE_TEST_POSTGRES_URL pointing to disposable local Postgres"]
async fn postgres_inspection_is_read_only_and_does_not_create_database()
-> Result<(), Box<dyn Error>> {
    use sqlx::Connection as _;
    let base = std::env::var("STORE_TEST_POSTGRES_URL")?;
    let mut admin = sqlx::PgConnection::connect(&base).await?;
    let suffix = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)?
        .as_nanos();
    let name = format!("store_inspect_{suffix}");
    let url = format!("{}/{name}", base.rsplit_once('/').ok_or("database URL")?.0);
    let config = StoreConfig::Postgres {
        url: url.clone(),
        max_connections: 2,
    };
    assert!(
        Store::inspect_migrations(config.clone())
            .await?
            .iter()
            .all(|row| row.executed_at.is_none())
    );
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1)")
            .bind(&name)
            .fetch_one(&mut admin)
            .await?;
    assert!(!exists);
    let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
        .execute(&mut admin)
        .await?;
    let mut connection = sqlx::PgConnection::connect(&url).await?;
    assert!(
        Store::inspect_migrations(config.clone())
            .await?
            .iter()
            .all(|row| row.executed_at.is_none())
    );
    let exists: bool = sqlx::query_scalar("SELECT to_regclass('kysely_migration') IS NOT NULL")
        .fetch_one(&mut connection)
        .await?;
    assert!(!exists);
    let _ = sqlx::raw_sql("CREATE TABLE kysely_migration(name TEXT PRIMARY KEY, timestamp TEXT NOT NULL); INSERT INTO kysely_migration VALUES('0001_initial','old')").execute(&mut connection).await?;
    let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "ALTER DATABASE {name} SET default_transaction_read_only=on"
    )))
    .execute(&mut admin)
    .await?;
    let rows = Store::inspect_migrations(config).await?;
    assert_eq!(
        rows.first().and_then(|row| row.executed_at.as_deref()),
        Some("old")
    );
    assert_eq!(
        rows.iter().filter(|row| row.executed_at.is_none()).count(),
        8
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM kysely_migration")
        .fetch_one(&mut connection)
        .await?;
    assert_eq!(count, 1);
    let later: bool = sqlx::query_scalar("SELECT to_regclass('dashboard_finalized') IS NOT NULL")
        .fetch_one(&mut connection)
        .await?;
    assert!(!later);
    Ok(())
}
