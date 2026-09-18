// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::{MigrationStatusRow, Store, StoreConfig, StoreError, migrations::NAMES};
use std::{path::Path, sync::Arc};

impl Store {
    /// Inspect the migration ledger without applying migrations or creating storage.
    /// A missing database or ledger reports every known migration as pending.
    ///
    /// # Errors
    /// Returns connection, invalid configuration, or unsupported migration history errors.
    pub async fn inspect_migrations(
        config: StoreConfig,
    ) -> Result<Vec<MigrationStatusRow>, StoreError> {
        let rows = match config {
            StoreConfig::Turso { path } => {
                tokio::task::spawn_blocking(move || inspect_turso(&path))
                    .await
                    .map_err(|error| StoreError::Database(error.to_string()))??
            }
            StoreConfig::Postgres {
                url,
                max_connections,
            } => {
                if url.trim().is_empty()
                    || !(url.starts_with("postgres://") || url.starts_with("postgresql://"))
                    || max_connections == 0
                {
                    return Err(StoreError::Invalid(
                        "invalid Postgres URL or pool size".into(),
                    ));
                }
                #[cfg(feature = "postgres")]
                {
                    inspect_postgres(&url).await?
                }
                #[cfg(not(feature = "postgres"))]
                {
                    return Err(StoreError::Invalid(
                        "Postgres support was not compiled".into(),
                    ));
                }
            }
        };
        if rows.len() > NAMES.len() {
            return Err(StoreError::MigrationHistory("unknown migrations".into()));
        }
        for ((name, _), expected) in rows.iter().zip(NAMES) {
            if name != expected {
                return Err(StoreError::MigrationHistory(format!(
                    "expected {expected}, found {name}"
                )));
            }
        }
        Ok(NAMES
            .iter()
            .enumerate()
            .map(|(index, name)| MigrationStatusRow {
                name: (*name).into(),
                executed_at: rows.get(index).map(|(_, timestamp)| timestamp.clone()),
            })
            .collect())
    }
}

fn inspect_turso(path: &Path) -> Result<Vec<(String, String)>, StoreError> {
    if path.as_os_str().is_empty() {
        return Err(StoreError::Invalid("empty Turso path".into()));
    }
    match std::fs::metadata(path) {
        Ok(metadata) if !metadata.is_file() => {
            return Err(StoreError::Invalid("Turso path is not a file".into()));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    }
    let path = path
        .to_str()
        .ok_or_else(|| StoreError::Invalid("non-UTF8 Turso path".into()))?;
    // The high-level Turso builder exposes no read-only flags. Use the same engine directly.
    let io = Arc::new(turso_core::UnixIO::new()?);
    let database = turso_core::Database::open_file_with_flags(
        io,
        path,
        turso_core::OpenFlags::ReadOnly,
        turso_core::DatabaseOpts::new(),
        None,
    )?;
    let connection = database.connect()?;
    connection.set_query_only(true);
    let present = connection
        .prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name='kysely_migration' LIMIT 1",
        )?
        .run_collect_rows()?;
    if present.is_empty() {
        return Ok(Vec::new());
    }
    let rows = connection
        .prepare(format!(
            "SELECT name,timestamp FROM kysely_migration ORDER BY name LIMIT {}",
            NAMES.len() + 1
        ))?
        .run_collect_rows()?;
    rows.iter()
        .map(|row| {
            let name = row
                .first()
                .and_then(turso_core::Value::to_text)
                .ok_or_else(|| StoreError::MigrationHistory("invalid migration name".into()))?;
            let timestamp = row
                .get(1)
                .and_then(turso_core::Value::to_text)
                .ok_or_else(|| {
                    StoreError::MigrationHistory("invalid migration timestamp".into())
                })?;
            Ok((name.into(), timestamp.into()))
        })
        .collect()
}

#[cfg(feature = "postgres")]
async fn inspect_postgres(url: &str) -> Result<Vec<(String, String)>, StoreError> {
    use sqlx::Connection as _;
    let mut connection = match sqlx::PgConnection::connect(url).await {
        Ok(connection) => connection,
        Err(sqlx::Error::Database(error)) if error.code().as_deref() == Some("3D000") => {
            return Ok(Vec::new());
        }
        Err(error) => return Err(error.into()),
    };
    let result = async {
        let mut transaction = connection.begin_with("BEGIN READ ONLY").await?;
        let present: bool =
            sqlx::query_scalar("SELECT to_regclass('kysely_migration') IS NOT NULL")
                .fetch_one(&mut *transaction)
                .await?;
        let rows = if present {
            let sql = format!(
                "SELECT name,timestamp FROM kysely_migration ORDER BY name LIMIT {}",
                NAMES.len() + 1
            );
            sqlx::query_as(sqlx::AssertSqlSafe(sql))
                .fetch_all(&mut *transaction)
                .await?
        } else {
            Vec::new()
        };
        transaction.rollback().await?;
        Ok::<_, StoreError>(rows)
    }
    .await;
    let closed = connection.close().await.map_err(StoreError::from);
    let rows = result?;
    closed?;
    Ok(rows)
}
