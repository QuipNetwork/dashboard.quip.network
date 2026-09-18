// SPDX-License-Identifier: AGPL-3.0-or-later
//! A database that already holds winner blocks gains filled node summaries.
use dashboard_store::{Store, StoreConfig};
use std::error::Error;

/// Two alice wins (qblocks 9 and 44) and one bob win, as a pre-0008 writer left them.
const BLOCKS: &str = "INSERT INTO blocks(block_hash,substrate_block_number,substrate_block_hash,substrate_parent_hash,timestamp,miner_id,energy,diversity,num_valid_solutions,mining_time,reward,nonce,num_nodes,num_edges,difficulty_energy,min_diversity,min_solutions,qblock_id) VALUES \
('h9','90','s9','p9',1000,'alice',-5.0,0.5,1,10.0,'1','1',8,16,-4.0,0.1,1,9),\
('h44','440','s44','p44',2000,'alice',-7.0,0.5,1,20.0,'1','1',8,16,-4.0,0.1,1,44),\
('h50','500','s50','p50',3000,'bob',-6.0,0.5,1,30.0,'1','1',8,16,-4.0,0.1,1,50)";

async fn assert_filled(store: &Store) -> Result<(), Box<dyn Error>> {
    let alice = store.get_node_summary("alice").await?.ok_or("alice")?;
    assert_eq!(alice.wins, 2);
    assert_eq!(alice.last_won_qblock_id, 44.into());
    assert_eq!(alice.last_won_block_hash, "h44");
    assert_eq!(alice.last_won_at, 2000);
    assert!((alice.avg_mining_time - 15.0).abs() < f64::EPSILON);
    assert!((alice.best_energy + 7.0).abs() < f64::EPSILON);
    let wins = store.get_miner_wins().await?;
    assert_eq!(
        wins.iter()
            .map(|row| row.miner_id.as_str())
            .collect::<Vec<_>>(),
        ["alice", "bob"]
    );
    Ok(())
}

#[tokio::test]
async fn turso_fills_node_summary_from_existing_blocks() -> Result<(), Box<dyn Error>> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("adopt.db");
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
    connection.execute_batch(BLOCKS).await?;
    drop(connection);
    drop(database);
    assert_filled(&Store::open(StoreConfig::Turso { path }).await?).await
}

#[cfg(feature = "postgres")]
#[tokio::test]
#[ignore = "requires STORE_TEST_POSTGRES_URL pointing to disposable local Postgres"]
async fn postgres_fills_node_summary_from_existing_blocks() -> Result<(), Box<dyn Error>> {
    use sqlx::Connection as _;
    let base = std::env::var("STORE_TEST_POSTGRES_URL")?;
    let mut admin = sqlx::PgConnection::connect(&base).await?;
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let name = format!("store_node_summary_{suffix}");
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
    let _ = sqlx::raw_sql(BLOCKS).execute(&mut c).await?;
    c.close().await?;
    assert_filled(
        &Store::open(StoreConfig::Postgres {
            url,
            max_connections: 1,
        })
        .await?,
    )
    .await
}
