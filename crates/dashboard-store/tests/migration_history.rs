// SPDX-License-Identifier: AGPL-3.0-or-later
//! Adoption of all historical Kysely stopping points using isolated Postgres databases.
#[cfg(feature = "postgres")]
mod postgres {
    use dashboard_store::{Store, StoreConfig};
    use sqlx::{Connection, Row};
    use std::error::Error;
    const HISTORICAL: [(&str, &str); 7] = [
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
    ];
    #[tokio::test]
    #[ignore = "requires STORE_TEST_POSTGRES_URL pointing to disposable local Postgres"]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "Test assertions report regressions while setup propagates errors"
    )]
    async fn adopt_every_historical_prefix_and_preserve_ledger() -> Result<(), Box<dyn Error>> {
        let base = std::env::var("STORE_TEST_POSTGRES_URL")?;
        let mut admin = sqlx::PgConnection::connect(&base).await?;
        for stop in 0..=7 {
            let suffix = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos();
            let name = format!("store_migration_{stop}_{suffix}");
            // Names are generated solely from the fixed integer loop above.
            let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
                .execute(&mut admin)
                .await?;
            let prefix = base.rsplit_once('/').ok_or("invalid test URL")?.0;
            let url = format!("{prefix}/{name}");
            let mut c = sqlx::PgConnection::connect(&url).await?;
            let _ = sqlx::raw_sql("CREATE TABLE kysely_migration(name VARCHAR(255) PRIMARY KEY,timestamp VARCHAR(255) NOT NULL)").execute(&mut c).await?;
            for (migration, sql) in HISTORICAL.iter().take(stop) {
                let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(*sql))
                    .execute(&mut c)
                    .await?;
                let _ = sqlx::query(
                    "INSERT INTO kysely_migration VALUES($1,'2020-01-01T00:00:00.000Z')",
                )
                .bind(migration)
                .execute(&mut c)
                .await?;
            }
            if stop > 0 {
                let _ = sqlx::query("INSERT INTO meta VALUES('self_address','preserve-account')")
                    .execute(&mut c)
                    .await?;
            }
            let store = Store::open(StoreConfig::Postgres {
                url,
                max_connections: 1,
            })
            .await?;
            assert_eq!(store.migration_status().await?.len(), 10);
            if stop > 0 {
                assert_eq!(
                    store.get_self_address().await?.as_deref(),
                    Some("preserve-account")
                );
            }
            for row in store.migration_status().await?.iter().take(stop) {
                assert_eq!(row.executed_at.as_deref(), Some("2020-01-01T00:00:00.000Z"));
            }
            drop(store);
            c.close().await?;
        }
        Ok(())
    }
    #[tokio::test]
    #[ignore = "requires STORE_TEST_POSTGRES_URL pointing to disposable local Postgres"]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "Test assertions report regressions while setup propagates errors"
    )]
    async fn canonical_no_ledger_and_descriptor_drift() -> Result<(), Box<dyn Error>> {
        let base = std::env::var("STORE_TEST_POSTGRES_URL")?;
        let mut admin = sqlx::PgConnection::connect(&base).await?;
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let name = format!("store_adoption_{suffix}");
        let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
            .execute(&mut admin)
            .await?;
        let prefix = base.rsplit_once('/').ok_or("invalid test URL")?.0;
        let url = format!("{prefix}/{name}");
        let mut c = sqlx::PgConnection::connect(&url).await?;
        for (_, sql) in HISTORICAL {
            let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
                .execute(&mut c)
                .await?;
        }
        let _ = sqlx::raw_sql("INSERT INTO meta VALUES('indexer.generation.winners','4'); INSERT INTO node_descriptors VALUES('alice',100,'0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',0,1000,10,'{\"schema\":\"quip.node_descriptor.v1\",\"descriptorVersion\":1,\"nodeName\":\"preserved\"}', '2020-01-01T00:00:00Z'); INSERT INTO validator_authorship VALUES('old',100,2,99,'2020-01-01T00:00:00Z'); INSERT INTO validator_authorship_blocks VALUES('old',99,'2020-01-01T00:00:00Z',true)").execute(&mut c).await?;
        let store = Store::open(StoreConfig::Postgres {
            url: url.clone(),
            max_connections: 1,
        })
        .await?;
        assert_eq!(
            store
                .generation(dashboard_store::Indexable::Winners)
                .await?,
            4
        );
        assert_eq!(
            store
                .get_all_node_descriptors()
                .await?
                .first()
                .ok_or("descriptor")?
                .first_block_timestamp,
            10
        );
        assert_eq!(
            store
                .get_validator_authorship()
                .await?
                .first()
                .ok_or("authorship")?
                .blocks_authored,
            100
        );
        drop(store);
        let _ = sqlx::raw_sql("DROP TABLE node_descriptors; CREATE TABLE node_descriptors(account_id TEXT PRIMARY KEY,block_number NUMERIC NOT NULL,payload_hash TEXT NOT NULL,block_timestamp BIGINT NOT NULL,first_block_timestamp BIGINT NOT NULL,descriptor JSONB NOT NULL,observed_at TIMESTAMPTZ NOT NULL); DELETE FROM kysely_migration WHERE name >= '0004'").execute(&mut c).await?;
        let store = Store::open(StoreConfig::Postgres {
            url: url.clone(),
            max_connections: 1,
        })
        .await?;
        assert!(store.get_all_node_descriptors().await?.is_empty());
        drop(store);
        let count:i64=sqlx::query("SELECT count(*) AS n FROM information_schema.columns WHERE table_name='node_descriptors' AND column_name='block_hash'").fetch_one(&mut c).await?.try_get("n")?;
        assert_eq!(count, 1);
        let _ = sqlx::query("INSERT INTO kysely_migration VALUES('9999_unknown','2021-01-01')")
            .execute(&mut c)
            .await?;
        assert!(
            Store::open(StoreConfig::Postgres {
                url,
                max_connections: 1
            })
            .await
            .is_err()
        );
        Ok(())
    }
}
