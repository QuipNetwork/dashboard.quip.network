// SPDX-License-Identifier: AGPL-3.0-or-later
//! Stored mining submissions move from miner numbering to chain qblock ids.
use dashboard_store::{Store, StoreConfig};
use std::error::Error;

/// Two consecutive miner-numbered rows, as a pre-0011 writer stored them. A
/// one-pass `+ 1` would collide on the primary key.
const SUBMISSIONS: &str = "INSERT INTO mining_submissions(miner_id,solution_number,ts_ns,energy_milli,diversity_milli,threshold_milli,last_proof_block_hash,outcome,attempt_count,best_energy_milli,observed_at) VALUES \
('alice',9,1,-5,0,-4,'0x09','rejected',3,-5,'2020-01-01T00:00:00.000Z'),\
('alice',10,2,-6,0,-4,'0x10','won',4,-6,'2020-01-01T00:00:00.000Z')";

async fn assert_renumbered(store: &Store) -> Result<(), Box<dyn Error>> {
    let rows = store.get_recent_mining_submissions("alice", 10).await?;
    let numbers: Vec<_> = rows.iter().map(|row| row.solution_number).collect();
    assert_eq!(numbers, [11, 10]);
    let won = rows.first().ok_or("row")?;
    assert_eq!(won.outcome, "won");
    assert_eq!(won.last_proof_block_hash, "0x10");
    Ok(())
}

#[tokio::test]
async fn turso_shifts_submissions_to_chain_ids() -> Result<(), Box<dyn Error>> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("renumber.db");
    let database = turso::Builder::new_local(path.to_str().ok_or("path")?)
        .with_io("syscall".into())
        .build()
        .await?;
    let connection = database.connect()?;
    connection
        .execute_batch("CREATE TABLE kysely_migration(name VARCHAR(255) NOT NULL PRIMARY KEY, timestamp VARCHAR(255) NOT NULL)")
        .await?;
    for (name, sql) in [
        (
            "0001_initial",
            include_str!("../migrations/turso/0001_initial.sql"),
        ),
        (
            "0002_telemetry_sort_indexes",
            include_str!("../migrations/turso/0002_telemetry_sort_indexes.sql"),
        ),
        (
            "0003_protocol_v0_2_sync",
            include_str!("../migrations/turso/0003_protocol_v0_2_sync.sql"),
        ),
        (
            "0004_reconcile_descriptors_topology_tags",
            include_str!("../migrations/turso/0004_reconcile_descriptors_topology_tags.sql"),
        ),
        (
            "0005_authorship_blocks_difficulty_source",
            include_str!("../migrations/turso/0005_authorship_blocks_difficulty_source.sql"),
        ),
        (
            "0006_blocks_device_access_time",
            include_str!("../migrations/turso/0006_blocks_device_access_time.sql"),
        ),
        (
            "0007_qblock_participation",
            include_str!("../migrations/turso/0007_qblock_participation.sql"),
        ),
    ] {
        connection.execute_batch(sql).await?;
        let _ = connection
            .execute(
                "INSERT INTO kysely_migration VALUES(?1,'2020-01-01T00:00:00.000Z')",
                [name],
            )
            .await?;
    }
    connection.execute_batch(SUBMISSIONS).await?;
    drop(connection);
    drop(database);
    assert_renumbered(&Store::open(StoreConfig::Turso { path }).await?).await
}

#[cfg(feature = "postgres")]
#[tokio::test]
#[ignore = "requires STORE_TEST_POSTGRES_URL pointing to disposable local Postgres"]
async fn postgres_shifts_submissions_to_chain_ids() -> Result<(), Box<dyn Error>> {
    use sqlx::Connection as _;
    let base = std::env::var("STORE_TEST_POSTGRES_URL")?;
    let mut admin = sqlx::PgConnection::connect(&base).await?;
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let name = format!("store_renumber_{suffix}");
    let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
        .execute(&mut admin)
        .await?;
    let url = format!(
        "{}/{name}",
        base.rsplit_once('/').ok_or("test database URL")?.0
    );
    let mut c = sqlx::PgConnection::connect(&url).await?;
    let _ = sqlx::raw_sql("CREATE TABLE kysely_migration(name VARCHAR(255) PRIMARY KEY,timestamp VARCHAR(255) NOT NULL)").execute(&mut c).await?;
    for (migration, sql) in [
        (
            "0001_initial",
            include_str!("../migrations/postgres/0001_initial.sql"),
        ),
        (
            "0002_telemetry_sort_indexes",
            include_str!("../migrations/postgres/0002_telemetry_sort_indexes.sql"),
        ),
        (
            "0003_protocol_v0_2_sync",
            include_str!("../migrations/postgres/0003_protocol_v0_2_sync.sql"),
        ),
        (
            "0004_reconcile_descriptors_topology_tags",
            include_str!("../migrations/postgres/0004_reconcile_descriptors_topology_tags.sql"),
        ),
        (
            "0005_authorship_blocks_difficulty_source",
            include_str!("../migrations/postgres/0005_authorship_blocks_difficulty_source.sql"),
        ),
        (
            "0006_blocks_device_access_time",
            include_str!("../migrations/postgres/0006_blocks_device_access_time.sql"),
        ),
        (
            "0007_qblock_participation",
            include_str!("../migrations/postgres/0007_qblock_participation.sql"),
        ),
    ] {
        let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
            .execute(&mut c)
            .await?;
        let _ = sqlx::query("INSERT INTO kysely_migration VALUES($1,'2020-01-01T00:00:00.000Z')")
            .bind(migration)
            .execute(&mut c)
            .await?;
    }
    let _ = sqlx::raw_sql(SUBMISSIONS).execute(&mut c).await?;
    c.close().await?;
    assert_renumbered(
        &Store::open(StoreConfig::Postgres {
            url,
            max_connections: 1,
        })
        .await?,
    )
    .await
}
