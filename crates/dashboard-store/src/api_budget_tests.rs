// SPDX-License-Identifier: AGPL-3.0-or-later
//! Public reads enforce capacity while collecting rows on both engines.

use crate::{
    Store, StoreConfig, StoreError,
    backend::{API_BYTES, API_ROWS},
};
use std::error::Error;
type TestResult = Result<(), Box<dyn Error>>;

async fn seed(writer: &Store) -> TestResult {
    writer
        .bind_network(&format!("0x{:064x}", 0).parse()?, &[])
        .await?;
    let mut tx = writer.write().await?;
    tx.conn()
        .batch("CREATE TABLE api_probe(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)")
        .await?;
    for start in (1..=API_ROWS + 1).step_by(256) {
        let values = (start..=(start + 255).min(API_ROWS + 1))
            .map(|id| format!("({id},'small')"))
            .collect::<Vec<_>>()
            .join(",");
        tx.conn()
            .batch(&format!("INSERT INTO api_probe VALUES {values}"))
            .await?;
    }
    tx.commit().await?;
    Ok(())
}
async fn check(writer: &Store, reader: &Store) -> TestResult {
    assert_eq!(
        reader
            .query_api("SELECT id,payload FROM api_probe WHERE id<=5000", &[])
            .await?
            .len(),
        5000
    );
    assert!(matches!(
        reader
            .query_api("SELECT id,payload FROM api_probe", &[])
            .await,
        Err(StoreError::Capacity)
    ));
    assert_eq!(
        reader
            .query_api("SELECT COUNT(*) AS count FROM api_probe", &[])
            .await?
            .len(),
        1
    );
    let payload = "x".repeat(4096);
    let _ = writer
        .mutate(
            "UPDATE api_probe SET payload=?1 WHERE id<=3000",
            &[payload.into()],
        )
        .await?;
    assert!(matches!(
        reader
            .query_api("SELECT payload FROM api_probe WHERE id<=3000", &[])
            .await,
        Err(StoreError::Capacity)
    ));
    writer
        .set_self_address(Some(&"x".repeat(API_BYTES + 1)))
        .await?;
    assert!(matches!(
        reader.get_self_address().await,
        Err(StoreError::Capacity)
    ));
    let nested = format!("[{}0]", "0,".repeat(100_000));
    writer
        .set_meta("mineable_topologies", Some(&nested))
        .await?;
    assert!(matches!(
        reader.get_mineable_topologies().await,
        Err(StoreError::Capacity)
    ));
    writer.set_self_address(Some("recovered")).await?;
    assert_eq!(
        reader.get_self_address().await?.as_deref(),
        Some("recovered")
    );
    Ok(())
}
#[tokio::test]
async fn api_capacity_turso() -> TestResult {
    let directory = tempfile::tempdir()?;
    let store = Store::open(StoreConfig::Turso {
        path: directory.path().join("budget.db"),
    })
    .await?;
    seed(&store).await?;
    check(&store, &store).await?;
    store.close().await?;
    Ok(())
}
#[cfg(feature = "postgres")]
#[tokio::test]
#[ignore = "requires STORE_TEST_POSTGRES_URL pointing to a unique disposable database"]
async fn api_capacity_postgres_read_only_pool() -> TestResult {
    let url = std::env::var("STORE_TEST_POSTGRES_URL")?;
    let writer = Store::open(StoreConfig::Postgres {
        url: url.clone(),
        max_connections: 2,
    })
    .await?;
    seed(&writer).await?;
    let reader = Store::open_read_only_postgres(&url, 2).await?;
    check(&writer, &reader).await?;
    reader.close().await?;
    writer.close().await?;
    Ok(())
}
