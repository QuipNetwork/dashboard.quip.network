// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::{
    MigrationStatusRow, Store, StoreError,
    backend::{Connection, now, text},
};
pub(crate) const NAMES: [&str; 9] = [
    "0001_initial",
    "0002_telemetry_sort_indexes",
    "0003_protocol_v0_2_sync",
    "0004_reconcile_descriptors_topology_tags",
    "0005_authorship_blocks_difficulty_source",
    "0006_blocks_device_access_time",
    "0007_qblock_participation",
    "0008_rust_writer_state",
    "0009_permanent_unavailable",
];
macro_rules! sqls {
    ($dir:literal) => {
        [
            include_str!(concat!("../migrations/", $dir, "/0001_initial.sql")),
            include_str!(concat!(
                "../migrations/",
                $dir,
                "/0002_telemetry_sort_indexes.sql"
            )),
            include_str!(concat!(
                "../migrations/",
                $dir,
                "/0003_protocol_v0_2_sync.sql"
            )),
            include_str!(concat!(
                "../migrations/",
                $dir,
                "/0004_reconcile_descriptors_topology_tags.sql"
            )),
            include_str!(concat!(
                "../migrations/",
                $dir,
                "/0005_authorship_blocks_difficulty_source.sql"
            )),
            include_str!(concat!(
                "../migrations/",
                $dir,
                "/0006_blocks_device_access_time.sql"
            )),
            include_str!(concat!(
                "../migrations/",
                $dir,
                "/0007_qblock_participation.sql"
            )),
            include_str!(concat!(
                "../migrations/",
                $dir,
                "/0008_rust_writer_state.sql"
            )),
            include_str!(concat!(
                "../migrations/",
                $dir,
                "/0009_permanent_unavailable.sql"
            )),
        ]
    };
}
pub(crate) async fn migrate(c: &mut Connection) -> Result<(), StoreError> {
    if c.pg() {
        c.batch("SELECT pg_advisory_lock(3853314791062309107)")
            .await?;
    }
    let result = apply(c).await;
    if result.is_err() {
        c.batch("ROLLBACK").await?;
    }
    if c.pg() {
        c.batch("SELECT pg_advisory_unlock(3853314791062309107)")
            .await?;
    }
    result
}
async fn apply(c: &mut Connection) -> Result<(), StoreError> {
    c.batch("BEGIN").await?;
    c.batch("CREATE TABLE IF NOT EXISTS kysely_migration (name VARCHAR(255) NOT NULL PRIMARY KEY, timestamp VARCHAR(255) NOT NULL); CREATE TABLE IF NOT EXISTS kysely_migration_lock (id VARCHAR(255) NOT NULL PRIMARY KEY, is_locked INTEGER NOT NULL DEFAULT 0); INSERT INTO kysely_migration_lock (id,is_locked) VALUES ('migration_lock',0) ON CONFLICT(id) DO NOTHING;").await?;
    let rows = c
        .query(
            "SELECT name,timestamp FROM kysely_migration ORDER BY name",
            &[],
        )
        .await?;
    if rows.len() > NAMES.len() {
        return Err(StoreError::MigrationHistory("unknown migrations".into()));
    }
    for (row, expected) in rows.iter().zip(NAMES) {
        let name = text(row, "name")?;
        if name != expected {
            return Err(StoreError::MigrationHistory(format!(
                "expected {expected}, found {name}"
            )));
        }
    }
    c.batch("COMMIT").await?;
    let scripts = if c.pg() {
        sqls!("postgres")
    } else {
        sqls!("turso")
    };
    for (name, script) in NAMES.iter().zip(scripts).skip(rows.len()) {
        c.batch("BEGIN").await?;
        c.batch(script).await?;
        let _ = c
            .execute(
                "INSERT INTO kysely_migration(name,timestamp) VALUES(?1,?2)",
                &[(*name).into(), now().into()],
            )
            .await?;
        c.batch("COMMIT").await?;
    }
    Ok(())
}
impl Store {
    /// Return supported migration names with their original execution timestamps.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn migration_status(&self) -> Result<Vec<MigrationStatusRow>, StoreError> {
        let rows = self
            .query(
                "SELECT name,timestamp FROM kysely_migration ORDER BY name",
                &[],
            )
            .await?;
        let mut out = Vec::new();
        for name in NAMES {
            let mut executed_at = None;
            for row in &rows {
                if text(row, "name")? == name {
                    executed_at = Some(text(row, "timestamp")?);
                    break;
                }
            }
            out.push(MigrationStatusRow {
                name: name.into(),
                executed_at,
            });
        }
        Ok(out)
    }
    /// List pending migrations without modifying storage.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn pending_migrations(&self) -> Result<Vec<String>, StoreError> {
        Ok(self
            .migration_status()
            .await?
            .into_iter()
            .filter(|m| m.executed_at.is_none())
            .map(|m| m.name)
            .collect())
    }
}
