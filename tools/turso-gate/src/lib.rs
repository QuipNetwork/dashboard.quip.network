// SPDX-License-Identifier: AGPL-3.0-or-later

//! Helpers for the standalone Turso Database qualification suite.
//!
//! This crate talks to the local Turso engine (`turso` 0.7.2), not libSQL and
//! not the `SQLx` SQLite driver. Experimental multi-process WAL and MVCC stay
//! off.

use turso::{Builder, Connection, Database, Value};

/// Canonical decimal form of `u256::MAX`.
pub const U256_MAX_DECIMAL: &str =
    "115792089237316195423570985008687907853269984665640564039457584007913129639935";

/// Indexed predecessor lookup that replaces `lag()` for participation windows.
///
/// Bind `?1` to the inclusive start timestamp. Rows whose predecessor is
/// missing (the first block ever) do not appear.
pub const PREDECESSOR_DURATIONS_SQL: &str = "\
SELECT b.qblock AS qblock, (b.ts - pred.ts) AS duration \
FROM blocks AS b \
INNER JOIN blocks AS pred \
  ON pred.qblock = ( \
    SELECT MAX(p.qblock) FROM blocks AS p WHERE p.qblock < b.qblock \
  ) \
WHERE b.ts >= ?1 \
  AND (b.ts - pred.ts) > 0 \
ORDER BY b.qblock ASC";

/// Qualification error with a readable message.
#[derive(Debug, thiserror::Error)]
pub enum GateError {
    /// Error from the Turso binding.
    #[error("turso: {0}")]
    Turso(#[from] turso::Error),
    /// Error from the local filesystem.
    #[error("I/O: {0}")]
    Io(#[from] std::io::Error),
    /// A value or protocol check failed.
    #[error("{0}")]
    Message(String),
}

impl From<&str> for GateError {
    fn from(value: &str) -> Self {
        Self::Message(value.to_owned())
    }
}

impl From<String> for GateError {
    fn from(value: String) -> Self {
        Self::Message(value)
    }
}

/// Result alias for qualification helpers.
pub type Result<T> = std::result::Result<T, GateError>;

/// Open a local Turso database with the engine default I/O backend.
///
/// Experimental multi-process WAL and MVCC flags are not set.
///
/// # Errors
///
/// Returns an error if the engine cannot create or open `path`.
pub async fn open_local(path: &str) -> Result<Database> {
    let db = Builder::new_local(path).build().await?;
    Ok(db)
}

/// Open a local Turso database with an explicit VFS name such as `syscall`.
///
/// # Errors
///
/// Returns an error if the named VFS is missing or the file cannot be opened.
pub async fn open_local_with_vfs(path: &str, vfs: &str) -> Result<Database> {
    let db = Builder::new_local(path)
        .with_io(vfs.to_owned())
        .build()
        .await?;
    Ok(db)
}

/// Switch the connection to standard WAL journaling.
///
/// # Errors
///
/// Returns an error if the journal-mode pragma fails or does not return text.
pub async fn enable_wal(conn: &Connection) -> Result<String> {
    let mut rows = conn.query("PRAGMA journal_mode = WAL", ()).await?;
    let row = rows.next().await?.ok_or("missing journal_mode row")?;
    require_text(row.get_value(0)?)
}

/// Create the block and cursor tables used by crash and rollback tests.
///
/// # Errors
///
/// Returns an error if a `CREATE TABLE` or `CREATE INDEX` statement fails.
pub async fn create_block_cursor_schema(conn: &Connection) -> Result<()> {
    let _changed = conn
        .execute(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            (),
        )
        .await?;
    let _changed = conn
        .execute(
            "CREATE TABLE IF NOT EXISTS blocks ( \
                qblock INTEGER PRIMARY KEY, \
                ts INTEGER NOT NULL \
            )",
            (),
        )
        .await?;
    let _changed = conn
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_blocks_qblock_ts ON blocks (qblock, ts)",
            (),
        )
        .await?;
    Ok(())
}

/// Insert one block and the cursor in the current transaction.
///
/// # Errors
///
/// Returns an error if either insert fails.
pub async fn insert_block_and_cursor(
    conn: &Connection,
    qblock: i64,
    ts: i64,
    cursor: &str,
) -> Result<()> {
    let _changed = conn
        .execute(
            "INSERT INTO blocks (qblock, ts) VALUES (?1, ?2)",
            (qblock, ts),
        )
        .await?;
    let _changed = conn
        .execute(
            "INSERT INTO meta (key, value) VALUES ('cursor', ?1) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [cursor],
        )
        .await?;
    Ok(())
}

/// Read the cursor value, if present.
///
/// # Errors
///
/// Returns an error if the query fails or the stored value is not text.
pub async fn read_cursor(conn: &Connection) -> Result<Option<String>> {
    let mut rows = conn
        .query("SELECT value FROM meta WHERE key = 'cursor'", ())
        .await?;
    match rows.next().await? {
        Some(row) => Ok(Some(require_text(row.get_value(0)?)?)),
        None => Ok(None),
    }
}

/// Count rows in `blocks`.
///
/// # Errors
///
/// Returns an error if the count query fails or does not return an integer.
pub async fn count_blocks(conn: &Connection) -> Result<i64> {
    let mut rows = conn.query("SELECT COUNT(*) FROM blocks", ()).await?;
    let row = rows.next().await?.ok_or("missing count")?;
    require_integer(row.get_value(0)?)
}

/// Require a text Turso value.
///
/// # Errors
///
/// Returns an error if `value` is not text.
pub fn require_text(value: Value) -> Result<String> {
    match value {
        Value::Text(text) => Ok(text),
        other => Err(GateError::Message(format!("expected text, got {other:?}"))),
    }
}

/// Require an integer Turso value.
///
/// # Errors
///
/// Returns an error if `value` is not an integer.
pub fn require_integer(value: Value) -> Result<i64> {
    match value {
        Value::Integer(n) => Ok(n),
        other => Err(GateError::Message(format!(
            "expected integer, got {other:?}"
        ))),
    }
}

/// Require a text value, or an integer rendered in decimal.
///
/// # Errors
///
/// Returns an error if `value` is neither an integer nor decimal text.
pub fn require_int_like(value: Value) -> Result<i64> {
    match value {
        Value::Integer(n) => Ok(n),
        Value::Text(text) => text
            .parse::<i64>()
            .map_err(|err| GateError::Message(format!("not an integer text: {err}"))),
        other => Err(GateError::Message(format!(
            "expected integer-like value, got {other:?}"
        ))),
    }
}

/// Return true when `err` looks like a permission failure.
#[must_use]
pub fn is_permission_error(err: &GateError) -> bool {
    match err {
        GateError::Io(io) => io.kind() == std::io::ErrorKind::PermissionDenied,
        GateError::Turso(turso_err) => {
            let text = turso_err.to_string().to_ascii_lowercase();
            text.contains("permission") || text.contains("eacces") || text.contains("read-only")
        }
        GateError::Message(text) => {
            let text = text.to_ascii_lowercase();
            text.contains("permission") || text.contains("eacces") || text.contains("read-only")
        }
    }
}

/// Return true when `err` looks like a disk-full or file-size failure.
#[must_use]
pub fn is_disk_full_error(err: &GateError) -> bool {
    match err {
        GateError::Io(io) => {
            io.kind() == std::io::ErrorKind::StorageFull
                || io.raw_os_error() == Some(28)
                || io.raw_os_error() == Some(27)
        }
        GateError::Turso(turso::Error::DatabaseFull(_)) => true,
        GateError::Turso(turso::Error::IoError(kind, _)) => {
            *kind == std::io::ErrorKind::StorageFull
                || *kind == std::io::ErrorKind::QuotaExceeded
                || *kind == std::io::ErrorKind::FileTooLarge
        }
        GateError::Turso(other) => {
            let text = other.to_string().to_ascii_lowercase();
            text.contains("database or disk is full")
                || text.contains("file too large")
                || text.contains("quota")
                || text.contains("enospc")
                || text.contains("efbig")
        }
        GateError::Message(text) => {
            let text = text.to_ascii_lowercase();
            text.contains("database or disk is full")
                || text.contains("file too large")
                || text.contains("quota")
                || text.contains("enospc")
                || text.contains("efbig")
        }
    }
}

/// Read resident set size in KiB from `/proc/self/status`.
#[must_use]
pub fn current_rss_kib() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        let Some(rest) = line.strip_prefix("VmRSS:") else {
            continue;
        };
        let token = rest.split_whitespace().next()?;
        return token.parse().ok();
    }
    None
}
