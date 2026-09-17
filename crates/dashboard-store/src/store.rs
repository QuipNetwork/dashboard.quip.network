// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::{
    StoreConfig, StoreError,
    backend::{Connection, RowData, canonical_timestamp, parameter, text},
    migrations,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Map, Value};
#[cfg(feature = "postgres")]
use sqlx::Connection as _;
use tokio::sync::{Mutex, MutexGuard};

pub(crate) struct Writer {
    pub(crate) conn: Connection,
    rollback: bool,
}
impl Writer {
    async fn recover(&mut self) -> Result<(), StoreError> {
        if self.rollback {
            self.conn.rollback().await?;
            self.rollback = false;
        }
        Ok(())
    }
}
pub(crate) struct Write<'a> {
    guard: MutexGuard<'a, Writer>,
    finished: bool,
}
impl<'a> Write<'a> {
    pub(crate) async fn begin(mut guard: MutexGuard<'a, Writer>) -> Result<Self, StoreError> {
        // BEGIN may reach the engine before its future is cancelled. Arm rollback first.
        guard.rollback = true;
        guard.conn.batch("BEGIN").await?;
        Ok(Self {
            guard,
            finished: false,
        })
    }
    pub(crate) fn conn(&mut self) -> &mut Connection {
        &mut self.guard.conn
    }
    pub(crate) async fn commit(mut self) -> Result<(), StoreError> {
        self.guard.conn.batch("COMMIT").await?;
        self.guard.rollback = false;
        self.finished = true;
        Ok(())
    }
}
impl Drop for Write<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.guard.rollback = true;
        }
    }
}
pub(crate) enum Readers {
    Turso(turso::Database),
    #[cfg(feature = "postgres")]
    Postgres(sqlx::PgPool),
}
/// Shared store. Writable instances own the writer lease; API-only instances own readers.
pub struct Store {
    pub(crate) writer: Option<Mutex<Writer>>,
    readers: Readers,
    api_reads: tokio::sync::Semaphore,
    _lock: Option<std::fs::File>,
}
impl Store {
    /// Open/migrate local storage. Genesis verification is a separate operation.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn open(config: StoreConfig) -> Result<Self, StoreError> {
        let (mut conn, readers, lock) = match config {
            StoreConfig::Turso { path } => {
                if path.as_os_str().is_empty() {
                    return Err(StoreError::Invalid("empty Turso path".into()));
                }
                let lock_path = path.with_extension("writer.lock");
                let file = std::fs::OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .read(true)
                    .write(true)
                    .open(lock_path)?;
                file.try_lock().map_err(|_| StoreError::WriterOwned)?;
                let path = path
                    .to_str()
                    .ok_or_else(|| StoreError::Invalid("non-UTF8 Turso path".into()))?;
                let db = turso::Builder::new_local(path)
                    .with_io("syscall".into())
                    .build()
                    .await?;
                let c = db.connect()?;
                c.busy_timeout(std::time::Duration::from_secs(10))?;
                (Connection::Turso(c), Readers::Turso(db), Some(file))
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
                    let mut conn = sqlx::PgConnection::connect(&url).await?;
                    let locked: bool =
                        sqlx::query_scalar("SELECT pg_try_advisory_lock(71648265094801)")
                            .fetch_one(&mut conn)
                            .await?;
                    if !locked {
                        return Err(StoreError::WriterOwned);
                    }
                    let pool = sqlx::postgres::PgPoolOptions::new()
                        .max_connections(max_connections)
                        .connect(&url)
                        .await?;
                    (Connection::Postgres(conn), Readers::Postgres(pool), None)
                }
                #[cfg(not(feature = "postgres"))]
                {
                    return Err(StoreError::Invalid(
                        "Postgres support was not compiled".into(),
                    ));
                }
            }
        };
        migrations::migrate(&mut conn).await?;
        Ok(Self {
            writer: Some(Mutex::new(Writer {
                conn,
                rollback: false,
            })),
            readers,
            api_reads: tokio::sync::Semaphore::new(4),
            _lock: lock,
        })
    }
    /// Open an API-only Postgres store alongside the database's owning writer.
    /// Requires the complete supported migration ledger and never applies migrations.
    /// Every pool connection defaults to read-only transactions.
    ///
    /// # Errors
    /// Returns connection errors or an actionable migration error for an incomplete schema.
    pub async fn open_read_only_postgres(
        url: &str,
        max_connections: u32,
    ) -> Result<Self, StoreError> {
        let status = Self::inspect_migrations(StoreConfig::Postgres {
            url: url.into(),
            max_connections,
        })
        .await?;
        let pending: Vec<_> = status
            .into_iter()
            .filter(|row| row.executed_at.is_none())
            .map(|row| row.name)
            .collect();
        if !pending.is_empty() {
            return Err(StoreError::MigrationHistory(format!(
                "API-only storage requires current schema; run migrate up first (pending: {})",
                pending.join(", ")
            )));
        }
        #[cfg(feature = "postgres")]
        {
            let options = url
                .parse::<sqlx::postgres::PgConnectOptions>()?
                .options([("default_transaction_read_only", "on")]);
            let pool = sqlx::postgres::PgPoolOptions::new()
                .max_connections(max_connections)
                .connect_with(options)
                .await?;
            Ok(Self {
                writer: None,
                readers: Readers::Postgres(pool),
                api_reads: tokio::sync::Semaphore::new(4),
                _lock: None,
            })
        }
        #[cfg(not(feature = "postgres"))]
        {
            Err(StoreError::Invalid(
                "Postgres support was not compiled".into(),
            ))
        }
    }
    pub(crate) fn ensure_writable(&self) -> Result<(), StoreError> {
        if self.writer.is_none() {
            return Err(StoreError::ReadOnly);
        }
        Ok(())
    }
    pub(crate) async fn write(&self) -> Result<Write<'_>, StoreError> {
        Write::begin(self.lock_writer().await?).await
    }
    pub(crate) async fn lock_writer(&self) -> Result<MutexGuard<'_, Writer>, StoreError> {
        let mut guard = self
            .writer
            .as_ref()
            .ok_or(StoreError::ReadOnly)?
            .lock()
            .await;
        guard.recover().await?;
        Ok(guard)
    }
    /// Roll back interrupted writes and close storage after every worker has drained.
    /// Ownership prevents further reads or writes once shutdown starts.
    ///
    /// # Errors
    /// Returns a pending rollback or connection shutdown failure. Connections still close
    /// if rollback fails.
    pub async fn close(self) -> Result<(), StoreError> {
        let Self {
            writer,
            readers,
            _lock: lock,
            ..
        } = self;
        let mut writer = writer.map(Mutex::into_inner);
        let rollback = if let Some(writer) = &mut writer {
            writer.recover().await
        } else {
            Ok(())
        };
        match readers {
            Readers::Turso(database) => drop(database),
            #[cfg(feature = "postgres")]
            Readers::Postgres(pool) => pool.close().await,
        }
        let closed = if let Some(writer) = writer {
            writer.conn.close().await
        } else {
            Ok(())
        };
        drop(lock);
        rollback.and(closed)
    }
    pub(crate) async fn query(
        &self,
        sql: &str,
        args: &[Value],
    ) -> Result<Vec<RowData>, StoreError> {
        match &self.readers {
            Readers::Turso(db) => Connection::Turso(db.connect()?).query(sql, args).await,
            #[cfg(feature = "postgres")]
            Readers::Postgres(pool) => {
                // The pool keeps concurrent readers independent of the lifetime writer.
                let mut conn = pool.acquire().await?;
                let query = format!(
                    "SELECT to_jsonb(result) AS data FROM ({}) result",
                    super::backend::postgres_sql(sql)
                );
                let mut q = sqlx::query_scalar::<_, Value>(sqlx::AssertSqlSafe(query.as_str()));
                for arg in args {
                    q = q.bind(match arg {
                        Value::Null => None,
                        Value::String(s) => Some(s.clone()),
                        Value::Bool(b) => Some(b.to_string()),
                        Value::Number(n) => Some(n.to_string()),
                        Value::Array(_) | Value::Object(_) => Some(arg.to_string()),
                    });
                }
                let rows = q.fetch_all(&mut *conn).await?;
                rows.into_iter()
                    .map(|v| {
                        if let Value::Object(m) = v {
                            Ok(m)
                        } else {
                            Err(StoreError::Invalid("invalid SQL row".into()))
                        }
                    })
                    .collect()
            }
        }
    }
    pub(crate) async fn query_api(
        &self,
        sql: &str,
        args: &[Value],
    ) -> Result<Vec<RowData>, StoreError> {
        // Data handlers already bound request admission. Limit concurrent row
        // decoding as well, including the thirteen telemetry joins on Turso.
        let _permit = self
            .api_reads
            .acquire()
            .await
            .map_err(|_| StoreError::Capacity)?;
        match &self.readers {
            Readers::Turso(database) => {
                Box::pin(Connection::Turso(database.connect()?).query_api(sql, args)).await
            }
            #[cfg(feature = "postgres")]
            Readers::Postgres(pool) => {
                let mut connection = pool.acquire().await?;
                let sql = format!(
                    "SELECT CASE WHEN pg_column_size(to_jsonb(api_result)) > {} THEN NULL ELSE to_jsonb(api_result)::text END AS data FROM ({}) api_result LIMIT {}",
                    crate::backend::API_BYTES,
                    crate::backend::postgres_sql(sql),
                    crate::backend::API_ROWS + 1
                );
                let mut query =
                    sqlx::query_scalar::<_, Option<String>>(sqlx::AssertSqlSafe(sql.as_str()));
                for arg in args {
                    query = query.bind(match arg {
                        Value::Null => None,
                        Value::String(value) => Some(value.clone()),
                        _ => Some(arg.to_string()),
                    });
                }
                let mut stream = query.fetch(&mut *connection);
                let mut budget = crate::backend::ApiBudget::default();
                let mut rows = Vec::new();
                while let Some(row) = std::future::poll_fn(|cx| stream.as_mut().poll_next(cx)).await
                {
                    let text = row?.ok_or(StoreError::Capacity)?;
                    let value = crate::backend::parse_api_json(&text)?;
                    let Value::Object(object) = value else {
                        return Err(StoreError::Invalid("invalid SQL row".into()));
                    };
                    budget.push(&object)?;
                    rows.push(object);
                }
                Ok(rows)
            }
        }
    }
    pub(crate) async fn api_rows<T: DeserializeOwned>(
        &self,
        sql: &str,
        args: &[Value],
    ) -> Result<Vec<T>, StoreError> {
        self.query_api(sql, args)
            .await?
            .into_iter()
            .map(decode)
            .collect()
    }
    pub(crate) async fn api_one<T: DeserializeOwned>(
        &self,
        sql: &str,
        args: &[Value],
    ) -> Result<Option<T>, StoreError> {
        self.api_rows(sql, args)
            .await
            .map(|rows| rows.into_iter().next())
    }
    pub(crate) async fn api_meta(&self, key: &str) -> Result<Option<String>, StoreError> {
        let rows = self
            .query_api("SELECT value FROM meta WHERE key=?1", &[key.into()])
            .await?;
        rows.first()
            .filter(|row| row.get("value") != Some(&Value::Null))
            .map(|row| text(row, "value"))
            .transpose()
    }
    pub(crate) fn pg(&self) -> bool {
        match self.readers {
            Readers::Turso(_) => false,
            #[cfg(feature = "postgres")]
            Readers::Postgres(_) => true,
        }
    }
    pub(crate) async fn rows<T: DeserializeOwned>(
        &self,
        sql: &str,
        args: &[Value],
    ) -> Result<Vec<T>, StoreError> {
        self.query(sql, args)
            .await?
            .into_iter()
            .map(decode)
            .collect()
    }
    pub(crate) async fn one<T: DeserializeOwned>(
        &self,
        sql: &str,
        args: &[Value],
    ) -> Result<Option<T>, StoreError> {
        self.rows(sql, args).await.map(|v| v.into_iter().next())
    }
    pub(crate) async fn mutate(&self, sql: &str, args: &[Value]) -> Result<u64, StoreError> {
        let mut tx = self.write().await?;
        let _ = require_bound(tx.conn()).await?;
        let n = tx.conn().execute(sql, args).await?;
        tx.commit().await?;
        Ok(n)
    }
    pub(crate) async fn meta(&self, key: &str) -> Result<Option<String>, StoreError> {
        let rows = self
            .query("SELECT value FROM meta WHERE key=?1", &[key.into()])
            .await?;
        rows.first()
            .filter(|r| r.get("value") != Some(&Value::Null))
            .map(|r| text(r, "value"))
            .transpose()
    }
    pub(crate) async fn set_meta(&self, key: &str, value: Option<&str>) -> Result<(), StoreError> {
        let mut tx = self.write().await?;
        let _ = require_bound(tx.conn()).await?;
        set_meta(tx.conn(), key, value).await?;
        tx.commit().await
    }
    pub(crate) async fn upsert<T: Serialize>(
        &self,
        table: &str,
        record: &T,
        keys: &[&str],
        exclude: &[&str],
        condition: Option<&str>,
    ) -> Result<(), StoreError> {
        let mut tx = self.write().await?;
        let _ = require_bound(tx.conn()).await?;
        let _ = upsert(tx.conn(), table, record, keys, exclude, condition).await?;
        tx.commit().await
    }
}
pub(crate) async fn get_meta(c: &mut Connection, key: &str) -> Result<Option<String>, StoreError> {
    let rows = c
        .query("SELECT value FROM meta WHERE key=?1", &[key.into()])
        .await?;
    rows.first()
        .filter(|r| r.get("value") != Some(&Value::Null))
        .map(|r| text(r, "value"))
        .transpose()
}
pub(crate) async fn set_meta(
    c: &mut Connection,
    key: &str,
    value: Option<&str>,
) -> Result<(), StoreError> {
    let _ = c.execute("INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",&[key.into(),value.map_or(Value::Null,Into::into)]).await?;
    Ok(())
}
pub(crate) async fn require_bound(c: &mut Connection) -> Result<String, StoreError> {
    get_meta(c, "dashboard.genesis")
        .await?
        .ok_or(StoreError::NetworkIdentity)
}
pub(crate) fn snake(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_uppercase() {
            out.push('_');
            out.extend(c.to_lowercase());
        } else {
            out.push(c);
        }
    }
    out.replace("q_block", "qblock")
}
fn camel(name: &str) -> String {
    if name == "current_qblock_id" {
        return "currentQBlockId".into();
    }
    if name == "current_qblock_participants" {
        return "currentQBlockParticipants".into();
    }
    let mut out = String::new();
    let mut upper = false;
    for c in name.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}
pub(crate) fn kind(column: &str) -> &'static str {
    match column {
        "substrate_block_number"
        | "reward"
        | "nonce"
        | "qblock_id"
        | "best_block_number"
        | "finalized_block_number"
        | "current_qblock_id"
        | "last_runtime_upgrade"
        | "current_slot"
        | "epoch_start_slot"
        | "deposit"
        | "proofs_submitted"
        | "proofs_won"
        | "rewards_earned"
        | "observed_at_block"
        | "last_authored_block"
        | "block_number"
        | "ts_ns"
        | "chain_block_number"
        | "device_access_time_us"
        | "solution_number"
        | "pow_sequence"
        | "qpu_access_time_us"
        | "winning_solutions_count" => "numeric",
        "energy" | "diversity" | "mining_time" | "difficulty_energy" | "min_diversity" => {
            "double precision"
        }
        "timestamp"
        | "block_timestamp"
        | "first_block_timestamp"
        | "energy_milli"
        | "diversity_milli"
        | "threshold_milli"
        | "best_energy_milli"
        | "blocks_authored"
        | "blocks_authored_with_pow" => "bigint",
        "num_valid_solutions"
        | "num_nodes"
        | "num_edges"
        | "min_solutions"
        | "id"
        | "finality_lag"
        | "current_qblock_participants"
        | "spec_version"
        | "transaction_version"
        | "epoch_index"
        | "slots_per_epoch"
        | "current_slot_in_epoch"
        | "authority_count"
        | "extrinsic_index"
        | "attempt_count"
        | "num_valid"
        | "budget_seconds" => "integer",
        "online" | "finalized" | "is_current" | "is_active" | "had_winner" => "boolean",
        "observed_at" | "updated_at" | "last_authored_at" => "timestamptz",
        "descriptor" | "miners" => "jsonb",
        _ => "text",
    }
}
pub(crate) async fn upsert<T: Serialize>(
    c: &mut Connection,
    table: &str,
    record: &T,
    keys: &[&str],
    exclude: &[&str],
    condition: Option<&str>,
) -> Result<u64, StoreError> {
    let Value::Object(object) = serde_json::to_value(record)? else {
        return Err(StoreError::Invalid("record must be object".into()));
    };
    let object: Map<String, Value> = object.into_iter().map(|(k, v)| (snake(&k), v)).collect();
    upsert_map(c, table, &object, keys, exclude, condition).await
}
pub(crate) async fn upsert_map(
    c: &mut Connection,
    table: &str,
    object: &Map<String, Value>,
    keys: &[&str],
    exclude: &[&str],
    condition: Option<&str>,
) -> Result<u64, StoreError> {
    let columns: Vec<_> = object.keys().cloned().collect();
    let mut args = Vec::with_capacity(columns.len());
    for column in &columns {
        let value = object
            .get(column)
            .cloned()
            .ok_or_else(|| StoreError::Invalid("missing record field".into()))?;
        if (kind(column) == "timestamptz"
            || (table == "validator_authorship_blocks" && column == "timestamp"))
            && !value.is_null()
        {
            let timestamp = value
                .as_str()
                .ok_or_else(|| StoreError::Invalid("timestamp must be ISO 8601".into()))?;
            args.push(Value::String(canonical_timestamp(timestamp)?));
        } else {
            args.push(value);
        }
    }
    let parameters: Vec<_> = columns
        .iter()
        .enumerate()
        .map(|(i, k)| {
            parameter(
                i + 1,
                if table == "validator_authorship_blocks" && k == "timestamp" {
                    "timestamptz"
                } else if table == "qblock_participation" && k == "block_number" {
                    "text"
                } else {
                    kind(k)
                },
                c.pg(),
            )
        })
        .collect();
    let update: Vec<_> = columns
        .iter()
        .filter(|k| !keys.contains(&k.as_str()) && !exclude.contains(&k.as_str()))
        .map(|k| format!("{k}=excluded.{k}"))
        .collect();
    let on_conflict = if condition == Some("NOTHING") || update.is_empty() {
        "DO NOTHING".into()
    } else {
        format!(
            "DO UPDATE SET {}{}",
            update.join(","),
            condition.map_or(String::new(), |s| format!(" WHERE {s}"))
        )
    };
    c.execute(
        &format!(
            "INSERT INTO {table}({}) VALUES({}) ON CONFLICT({}) {on_conflict}",
            columns.join(","),
            parameters.join(","),
            keys.join(",")
        ),
        &args,
    )
    .await
}
pub(crate) fn decode<T: DeserializeOwned>(row: RowData) -> Result<T, StoreError> {
    let mut out = Map::new();
    for (k, mut v) in row {
        if !v.is_null() {
            if kind(&k) == "numeric" && !numeric_api_number(&k) {
                v = Value::String(match v {
                    Value::String(s) => s,
                    other => other.to_string(),
                });
            }
            if numeric_api_number(&k)
                && let Value::String(number) = &v
            {
                v = serde_json::from_str(number)?;
            }
            if kind(&k) == "boolean"
                && let Some(i) = v.as_i64()
            {
                v = Value::Bool(i != 0);
            }
            if kind(&k) == "jsonb"
                && let Value::String(s) = &v
            {
                v = serde_json::from_str(s)?;
            }
            if kind(&k) == "timestamptz"
                && let Value::String(s) = &v
            {
                v = Value::String(canonical_timestamp(s)?);
            }
        }
        let _ = out.insert(camel(&k), v);
    }
    Ok(serde_json::from_value(Value::Object(out))?)
}

fn numeric_api_number(column: &str) -> bool {
    [
        "device_access_time_us",
        "solution_number",
        "pow_sequence",
        "qpu_access_time_us",
        "winning_solutions_count",
        "exact_qpu_access_us",
    ]
    .contains(&column)
}

#[cfg(test)]
mod lifecycle_tests {
    use super::{Store, StoreConfig};

    #[tokio::test]
    async fn recovery_when_cancelled_begin_did_not_start_transaction()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        let store = Store::open(StoreConfig::Turso {
            path: directory.path().join("cancel-before-begin.db"),
        })
        .await?;
        // Cancellation during BEGIN can leave the recovery flag armed without an SQL transaction.
        store
            .writer
            .as_ref()
            .ok_or("missing writer")?
            .lock()
            .await
            .rollback = true;
        let transaction = store.write().await?;
        transaction.commit().await?;
        {
            let mut transaction = store.write().await?;
            transaction
                .conn()
                .batch("INSERT INTO meta(key,value) VALUES('engine-rollback','first')")
                .await?;
            if transaction
                .conn()
                .batch(
                    "INSERT OR ROLLBACK INTO meta(key,value) VALUES('engine-rollback','duplicate')",
                )
                .await
                .is_ok()
            {
                return Err("duplicate key must roll back the transaction".into());
            }
        }
        // The engine also ends the transaction itself for an OR ROLLBACK constraint failure.
        let transaction = store.write().await?;
        transaction.commit().await?;
        if store.meta("engine-rollback").await?.is_some() {
            return Err("engine rollback must discard earlier writes".into());
        }
        store
            .writer
            .as_ref()
            .ok_or("missing writer")?
            .lock()
            .await
            .rollback = true;
        store.close().await?;
        Ok(())
    }
}
