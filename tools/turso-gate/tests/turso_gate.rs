// SPDX-License-Identifier: AGPL-3.0-or-later

//! Turso Database qualification gate.
//!
//! Cases run against the local `turso` 0.7.2 engine with standard WAL.

use std::error::Error;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use turso::Value;
use turso_gate::{
    count_blocks, create_block_cursor_schema, current_rss_kib, enable_wal, insert_block_and_cursor,
    is_disk_full_error, is_permission_error, open_local, open_local_with_vfs, read_cursor,
    require_int_like, require_integer, require_text, GateError, PREDECESSOR_DURATIONS_SQL,
    U256_MAX_DECIMAL,
};

type TestResult = Result<(), Box<dyn Error + Send + Sync>>;

fn check_eq<L, R>(left: &L, right: &R) -> TestResult
where
    L: PartialEq<R> + std::fmt::Debug,
    R: std::fmt::Debug,
{
    if left == right {
        Ok(())
    } else {
        Err(format!("check_eq failed: {left:?} != {right:?}").into())
    }
}

fn check(cond: bool, msg: &str) -> TestResult {
    if cond {
        Ok(())
    } else {
        Err(msg.into())
    }
}

fn utf8_path(path: &Path) -> Result<String, Box<dyn Error + Send + Sync>> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "non-UTF-8 test path".into())
}

fn crash_writer_bin() -> Result<PathBuf, Box<dyn Error + Send + Sync>> {
    let raw = option_env!("CARGO_BIN_EXE_turso_crash_writer")
        .ok_or("missing CARGO_BIN_EXE_turso_crash_writer")?;
    Ok(PathBuf::from(raw))
}

fn metrics_path() -> PathBuf {
    let dir =
        std::env::var("CARGO_TARGET_DIR").map_or_else(|_| PathBuf::from("target"), PathBuf::from);
    dir.join("turso-gate-metrics.txt")
}

fn append_metric(line: &str) -> TestResult {
    let path = metrics_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{line}")?;
    Ok(())
}

/// Return the running Docker server version, or `None` when Docker is absent
/// or the daemon does not answer.
fn docker_server_version() -> Option<String> {
    let out = Command::new("docker")
        .args(["info", "--format", "{{.ServerVersion}}"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

/// Return true when the glibc qualification image is present locally.
fn python_image_present() -> bool {
    Command::new("docker")
        .args(["image", "inspect", "python:3.12-slim-bookworm"])
        .output()
        .is_ok_and(|out| out.status.success())
}

/// Build a suffix for a unique container name from process id and monotonic
/// nanos, without adding a random-number dependency.
fn unique_container_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("{}-{nanos}", std::process::id())
}

fn host_uid() -> Option<u32> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|row| row.starts_with("Uid:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}

fn wal_path(db_path: &str) -> PathBuf {
    PathBuf::from(format!("{db_path}-wal"))
}

fn shm_path(db_path: &str) -> PathBuf {
    PathBuf::from(format!("{db_path}-shm"))
}

fn set_mode_if_exists(path: &Path, mode: u32) -> std::io::Result<()> {
    if path.exists() {
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    Ok(())
}

async fn collect_integers(
    conn: &turso::Connection,
    sql: &str,
    param: i64,
) -> Result<Vec<i64>, Box<dyn Error + Send + Sync>> {
    let mut rows = conn.query(sql, [param]).await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(require_int_like(row.get_value(0)?)?);
    }
    Ok(out)
}

#[tokio::test]
async fn committed_value_survives_reopen() -> TestResult {
    let dir = tempfile::tempdir()?;
    let file = dir.path().join("gate.db");
    let path = utf8_path(&file)?;
    {
        let db = turso::Builder::new_local(&path).build().await?;
        let conn = db.connect()?;
        let mode = enable_wal(&conn).await?;
        check_eq(&mode.to_ascii_lowercase(), &"wal")?;
        let _changed = conn
            .execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)", ())
            .await?;
        let _changed = conn.execute("BEGIN IMMEDIATE", ()).await?;
        let _changed = conn
            .execute("INSERT INTO meta VALUES ('cursor', '42')", ())
            .await?;
        let _changed = conn.execute("COMMIT", ()).await?;
    }
    let db = turso::Builder::new_local(&path).build().await?;
    let conn = db.connect()?;
    let mut rows = conn
        .query("SELECT value FROM meta WHERE key = 'cursor'", ())
        .await?;
    let row = rows.next().await?.ok_or("missing cursor")?;
    let Value::Text(value) = row.get_value(0)? else {
        return Err("expected cursor text".into());
    };
    check_eq(&value, &"42")?;
    Ok(())
}

#[tokio::test]
async fn rollback_drops_block_and_cursor_together() -> TestResult {
    let dir = tempfile::tempdir()?;
    let path = utf8_path(&dir.path().join("gate.db"))?;
    let db = open_local(&path).await?;
    let conn = db.connect()?;
    let _mode = enable_wal(&conn).await?;
    create_block_cursor_schema(&conn).await?;

    let _changed = conn.execute("BEGIN IMMEDIATE", ()).await?;
    insert_block_and_cursor(&conn, 1, 100, "1").await?;
    let _changed = conn.execute("COMMIT", ()).await?;
    check_eq(&read_cursor(&conn).await?, &Some("1".to_owned()))?;
    check_eq(&count_blocks(&conn).await?, &1)?;

    let _changed = conn.execute("BEGIN IMMEDIATE", ()).await?;
    insert_block_and_cursor(&conn, 2, 112, "2").await?;
    check_eq(&count_blocks(&conn).await?, &2)?;
    let _changed = conn.execute("ROLLBACK", ()).await?;

    check_eq(&read_cursor(&conn).await?, &Some("1".to_owned()))?;
    check_eq(&count_blocks(&conn).await?, &1)?;
    let mut rows = conn
        .query("SELECT qblock FROM blocks ORDER BY qblock", ())
        .await?;
    let row = rows.next().await?.ok_or("missing retained block")?;
    check_eq(&require_integer(row.get_value(0)?)?, &1)?;
    check(rows.next().await?.is_none(), "expected no extra block rows")?;
    Ok(())
}

#[tokio::test]
async fn upsert_updates_composite_primary_key() -> TestResult {
    let dir = tempfile::tempdir()?;
    let path = utf8_path(&dir.path().join("gate.db"))?;
    let db = open_local(&path).await?;
    let conn = db.connect()?;
    let _mode = enable_wal(&conn).await?;
    let _changed = conn
        .execute(
            "CREATE TABLE qblock_participation (\
                qblock_id INTEGER NOT NULL, \
                account TEXT NOT NULL, \
                kind TEXT NOT NULL, \
                budget_seconds INTEGER, \
                block_number TEXT NOT NULL, \
                PRIMARY KEY (qblock_id, account)\
            )",
            (),
        )
        .await?;
    let upsert = "INSERT INTO qblock_participation \
         (qblock_id, account, kind, budget_seconds, block_number) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(qblock_id, account) DO UPDATE SET \
           kind = excluded.kind, \
           budget_seconds = excluded.budget_seconds, \
           block_number = excluded.block_number";
    let _changed = conn
        .execute(upsert, (5_i64, "5Alice", "Cpu", Value::Null, "100"))
        .await?;
    let _changed = conn
        .execute(upsert, (5_i64, "5Alice", "QpuDwave", 120_i64, "105"))
        .await?;
    let _changed = conn
        .execute(upsert, (6_i64, "5Alice", "Gpu", 30_i64, "200"))
        .await?;

    let mut rows = conn
        .query(
            "SELECT qblock_id, account, kind, budget_seconds, block_number \
             FROM qblock_participation ORDER BY qblock_id, account",
            (),
        )
        .await?;
    let first = rows.next().await?.ok_or("missing first participation")?;
    check_eq(&require_integer(first.get_value(0)?)?, &5)?;
    check_eq(&require_text(first.get_value(1)?)?, &"5Alice")?;
    check_eq(&require_text(first.get_value(2)?)?, &"QpuDwave")?;
    check_eq(&require_integer(first.get_value(3)?)?, &120)?;
    check_eq(&require_text(first.get_value(4)?)?, &"105")?;
    let second = rows.next().await?.ok_or("missing second participation")?;
    check_eq(&require_integer(second.get_value(0)?)?, &6)?;
    check(
        rows.next().await?.is_none(),
        "expected no extra participation rows",
    )?;
    Ok(())
}

#[tokio::test]
async fn u256_decimal_round_trips_as_text() -> TestResult {
    let dir = tempfile::tempdir()?;
    let path = utf8_path(&dir.path().join("gate.db"))?;
    let db = open_local(&path).await?;
    let conn = db.connect()?;
    let _changed = conn
        .execute(
            "CREATE TABLE amounts (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
            (),
        )
        .await?;
    let _changed = conn
        .execute(
            "INSERT INTO amounts (id, value) VALUES (1, ?1)",
            [U256_MAX_DECIMAL],
        )
        .await?;
    let mut rows = conn
        .query("SELECT value, typeof(value) FROM amounts WHERE id = 1", ())
        .await?;
    let row = rows.next().await?.ok_or("missing amount")?;
    check_eq(&require_text(row.get_value(0)?)?, &U256_MAX_DECIMAL)?;
    check_eq(&require_text(row.get_value(1)?)?, &"text")?;
    Ok(())
}

#[tokio::test]
async fn json_extract_reads_descriptor_fields() -> TestResult {
    let dir = tempfile::tempdir()?;
    let path = utf8_path(&dir.path().join("gate.db"))?;
    let db = open_local(&path).await?;
    let conn = db.connect()?;
    let _changed = conn
        .execute(
            "CREATE TABLE node_descriptors (\
                account_id TEXT PRIMARY KEY, \
                descriptor TEXT NOT NULL\
            )",
            (),
        )
        .await?;
    let _changed = conn
        .execute(
            "INSERT INTO node_descriptors (account_id, descriptor) VALUES (?1, ?2)",
            ("5Alice", r#"{"nodeName":"alice","role":"validator"}"#),
        )
        .await?;
    let mut extracted = conn
        .query(
            "SELECT json_extract(descriptor, '$.nodeName') \
             FROM node_descriptors WHERE account_id = '5Alice'",
            (),
        )
        .await?;
    let row = extracted.next().await?.ok_or("missing json_extract")?;
    check_eq(&require_text(row.get_value(0)?)?, &"alice")?;

    let mut arrow = conn
        .query(
            "SELECT descriptor ->> '$.nodeName' \
             FROM node_descriptors WHERE account_id = '5Alice'",
            (),
        )
        .await?;
    let row = arrow.next().await?.ok_or("missing json arrow")?;
    check_eq(&require_text(row.get_value(0)?)?, &"alice")?;
    Ok(())
}

#[tokio::test]
async fn predecessor_query_replaces_lag() -> TestResult {
    let dir = tempfile::tempdir()?;
    let path = utf8_path(&dir.path().join("gate.db"))?;
    let db = open_local(&path).await?;
    let conn = db.connect()?;
    create_block_cursor_schema(&conn).await?;
    for (qblock, ts) in [(1_i64, 100_i64), (2, 112), (3, 130)] {
        let _changed = conn
            .execute(
                "INSERT INTO blocks (qblock, ts) VALUES (?1, ?2)",
                (qblock, ts),
            )
            .await?;
    }

    let lag = conn
        .query("SELECT ts - lag(ts) OVER (ORDER BY qblock) FROM blocks", ())
        .await;
    match lag {
        Ok(mut rows) => {
            while rows.next().await?.is_some() {}
            append_metric("lag_supported=1")?;
        }
        Err(err) => {
            let text = err.to_string().to_ascii_lowercase();
            if !(text.contains("lag")
                || text.contains("not supported")
                || text.contains("unknown")
                || text.contains("no such"))
            {
                return Err(format!("unexpected lag() error: {err}").into());
            }
            append_metric(&format!("lag_unsupported={err}"))?;
        }
    }

    let mut rows = conn.query(PREDECESSOR_DURATIONS_SQL, [112_i64]).await?;
    let mut durations = Vec::new();
    let mut qblocks = Vec::new();
    while let Some(row) = rows.next().await? {
        qblocks.push(require_integer(row.get_value(0)?)?);
        durations.push(require_int_like(row.get_value(1)?)?);
    }
    check_eq(&qblocks, &vec![2, 3])?;
    check_eq(&durations, &vec![12, 18])?;
    Ok(())
}

#[tokio::test]
async fn one_writer_four_readers_from_one_handle() -> TestResult {
    let dir = tempfile::tempdir()?;
    let path = utf8_path(&dir.path().join("gate.db"))?;
    let db = open_local(&path).await?;
    let writer = db.connect()?;
    let _mode = enable_wal(&writer).await?;
    create_block_cursor_schema(&writer).await?;
    let _changed = writer.execute("BEGIN IMMEDIATE", ()).await?;
    for qblock in 1_i64..=20 {
        insert_block_and_cursor(&writer, qblock, 100 + qblock, &qblock.to_string()).await?;
    }
    let _changed = writer.execute("COMMIT", ()).await?;

    let mut handles = Vec::new();
    for _ in 0..4 {
        let reader = db.connect()?;
        handles.push(tokio::spawn(async move {
            let count = count_blocks(&reader).await?;
            let mut rows = reader
                .query(
                    "SELECT qblock FROM blocks WHERE qblock > ?1 ORDER BY qblock LIMIT 3",
                    [10_i64],
                )
                .await?;
            let mut page = Vec::new();
            while let Some(row) = rows.next().await? {
                page.push(require_integer(row.get_value(0)?)?);
            }
            Ok::<_, GateError>((count, page))
        }));
    }

    for handle in handles {
        let (count, page) = handle.await??;
        check_eq(&count, &20)?;
        check_eq(&page, &vec![11, 12, 13])?;
    }

    let _changed = writer
        .execute("INSERT INTO blocks (qblock, ts) VALUES (21, 121)", ())
        .await?;
    let reader = db.connect()?;
    check_eq(&count_blocks(&reader).await?, &21)?;
    Ok(())
}

#[tokio::test]
async fn wal_checkpoint_then_reopen() -> TestResult {
    let dir = tempfile::tempdir()?;
    let path = utf8_path(&dir.path().join("gate.db"))?;
    let wal = wal_path(&path);
    {
        let db = open_local(&path).await?;
        let conn = db.connect()?;
        let mode = enable_wal(&conn).await?;
        check_eq(&mode.to_ascii_lowercase(), &"wal")?;
        create_block_cursor_schema(&conn).await?;
        let _changed = conn.execute("BEGIN IMMEDIATE", ()).await?;
        for qblock in 1_i64..=80 {
            insert_block_and_cursor(&conn, qblock, 1_000 + qblock, &qblock.to_string()).await?;
        }
        let _changed = conn.execute("COMMIT", ()).await?;
        conn.cacheflush()?;
        let wal_before = fs::metadata(&wal).map_or(0, |meta| meta.len());
        append_metric(&format!("wal_bytes_before_checkpoint={wal_before}"))?;

        let checkpoint = conn.query("PRAGMA wal_checkpoint", ()).await;
        match checkpoint {
            Ok(mut rows) => {
                let _row = rows.next().await?;
            }
            Err(err) => {
                append_metric(&format!("wal_checkpoint_noarg_error={err}"))?;
                let truncated = conn.query("PRAGMA wal_checkpoint(TRUNCATE)", ()).await;
                if let Err(trunc_err) = truncated {
                    append_metric(&format!("wal_checkpoint_truncate_error={trunc_err}"))?;
                    return Err(format!(
                        "wal_checkpoint failed: {err}; truncate failed: {trunc_err}"
                    )
                    .into());
                }
            }
        }
        let wal_after = fs::metadata(&wal).map_or(0, |meta| meta.len());
        append_metric(&format!("wal_bytes_after_checkpoint={wal_after}"))?;
        check_eq(&count_blocks(&conn).await?, &80)?;
        check_eq(&read_cursor(&conn).await?, &Some("80".to_owned()))?;
    }

    let db = open_local(&path).await?;
    let conn = db.connect()?;
    check_eq(&count_blocks(&conn).await?, &80)?;
    check_eq(&read_cursor(&conn).await?, &Some("80".to_owned()))?;
    let paged = collect_integers(
        &conn,
        "SELECT qblock FROM blocks WHERE qblock > ?1 ORDER BY qblock LIMIT 2",
        78,
    )
    .await?;
    check_eq(&paged, &vec![79, 80])?;
    Ok(())
}

#[tokio::test]
async fn syscall_vfs_opens_and_reopens() -> TestResult {
    let dir = tempfile::tempdir()?;
    let path = utf8_path(&dir.path().join("gate.db"))?;
    {
        let db = open_local_with_vfs(&path, "syscall").await?;
        let conn = db.connect()?;
        let _mode = enable_wal(&conn).await?;
        create_block_cursor_schema(&conn).await?;
        let _changed = conn.execute("BEGIN IMMEDIATE", ()).await?;
        insert_block_and_cursor(&conn, 3, 130, "3").await?;
        let _changed = conn.execute("COMMIT", ()).await?;
    }
    let db = open_local_with_vfs(&path, "syscall").await?;
    let conn = db.connect()?;
    check_eq(&read_cursor(&conn).await?, &Some("3".to_owned()))?;
    append_metric("vfs=syscall")?;
    Ok(())
}

#[tokio::test]
async fn default_io_backend_writes_without_privileged_flags() -> TestResult {
    let dir = tempfile::tempdir()?;
    let path = utf8_path(&dir.path().join("gate.db"))?;
    let db = open_local(&path).await?;
    let conn = db.connect()?;
    let mode = enable_wal(&conn).await?;
    create_block_cursor_schema(&conn).await?;
    let _changed = conn.execute("BEGIN IMMEDIATE", ()).await?;
    insert_block_and_cursor(&conn, 1, 100, "1").await?;
    let _changed = conn.execute("COMMIT", ()).await?;
    append_metric(&format!(
        "default_io_journal_mode={mode} arch={}",
        std::env::consts::ARCH
    ))?;
    check_eq(&std::env::consts::ARCH, &"x86_64")?;
    Ok(())
}

#[tokio::test]
async fn permission_denied_does_not_advance_cursor() -> TestResult {
    let uid = host_uid().ok_or("could not read /proc/self/status Uid")?;
    if uid == 0 {
        return Err("permission case requires a non-root uid".into());
    }

    let dir = tempfile::tempdir()?;
    let db_path = dir.path().join("gate.db");
    let path = utf8_path(&db_path)?;
    {
        let db = open_local(&path).await?;
        let conn = db.connect()?;
        let _mode = enable_wal(&conn).await?;
        create_block_cursor_schema(&conn).await?;
        let _changed = conn.execute("BEGIN IMMEDIATE", ()).await?;
        insert_block_and_cursor(&conn, 1, 100, "1").await?;
        let _changed = conn.execute("COMMIT", ()).await?;
    }

    let original_dir = fs::metadata(dir.path())?.permissions();
    set_mode_if_exists(&db_path, 0o444)?;
    set_mode_if_exists(&wal_path(&path), 0o444)?;
    set_mode_if_exists(&shm_path(&path), 0o444)?;
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555))?;
    let write_result = async {
        let db = open_local(&path).await?;
        let conn = db.connect()?;
        let _changed = conn.execute("BEGIN IMMEDIATE", ()).await?;
        insert_block_and_cursor(&conn, 2, 112, "2").await?;
        let _changed = conn.execute("COMMIT", ()).await?;
        Ok::<(), GateError>(())
    }
    .await;
    fs::set_permissions(dir.path(), original_dir)?;
    set_mode_if_exists(&db_path, 0o644)?;
    set_mode_if_exists(&wal_path(&path), 0o644)?;
    set_mode_if_exists(&shm_path(&path), 0o644)?;

    match write_result {
        Ok(()) => {
            return Err("write succeeded on a directory without write permission".into());
        }
        Err(err) => {
            append_metric(&format!("permission_error={err}"))?;
            if !is_permission_error(&err) {
                let text = err.to_string().to_ascii_lowercase();
                if !(text.contains("denied")
                    || text.contains("permission")
                    || text.contains("read-only")
                    || text.contains("eacces")
                    || text.contains("ro filesystem")
                    || text.contains("unable to open"))
                {
                    return Err(format!("error was not a permission failure: {err}").into());
                }
            }
        }
    }

    let db = open_local(&path).await?;
    let conn = db.connect()?;
    check_eq(&read_cursor(&conn).await?, &Some("1".to_owned()))?;
    check_eq(&count_blocks(&conn).await?, &1)?;
    let _changed = conn.execute("BEGIN IMMEDIATE", ()).await?;
    insert_block_and_cursor(&conn, 2, 112, "2").await?;
    let _changed = conn.execute("COMMIT", ()).await?;
    check_eq(&read_cursor(&conn).await?, &Some("2".to_owned()))?;
    Ok(())
}

fn spawn_writer(args: &[&str]) -> Result<std::process::Child, Box<dyn Error + Send + Sync>> {
    let bin = crash_writer_bin()?;
    let child = Command::new(bin)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    Ok(child)
}

fn wait_for_line(
    child: &mut std::process::Child,
    prefix: &str,
    timeout: Duration,
) -> Result<String, Box<dyn Error + Send + Sync>> {
    let stdout = child.stdout.take().ok_or("missing child stdout")?;
    let owned_prefix = prefix.to_owned();
    let (tx, rx) = mpsc::channel();
    let reader_thread = thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = tx.send(Err("child stdout closed".to_owned()));
                    break;
                }
                Ok(_) => {
                    if line.starts_with(&owned_prefix) {
                        let _ = tx.send(Ok(line));
                        break;
                    }
                }
                Err(err) => {
                    let _ = tx.send(Err(err.to_string()));
                    break;
                }
            }
        }
    });
    let result = match rx.recv_timeout(timeout) {
        Ok(Ok(line)) => Ok(line.trim().to_owned()),
        Ok(Err(err)) => Err(err.into()),
        Err(_) => {
            let _killed = child.kill();
            let stderr = child.stderr.take();
            let extra = stderr.map_or_else(String::new, |pipe| {
                let mut buf = String::new();
                let mut reader = BufReader::new(pipe);
                let _bytes = reader.read_line(&mut buf);
                buf
            });
            Err(format!("timed out waiting for {prefix}; stderr={extra}").into())
        }
    };
    drop(reader_thread);
    result
}

async fn reopen_block_cursor(
    path: &str,
) -> Result<(Option<String>, i64), Box<dyn Error + Send + Sync>> {
    let db = open_local(path).await?;
    let conn = db.connect()?;
    Ok((read_cursor(&conn).await?, count_blocks(&conn).await?))
}

#[tokio::test]
async fn sigkill_before_commit_drops_block_and_cursor() -> TestResult {
    let dir = tempfile::tempdir()?;
    let path = utf8_path(&dir.path().join("gate.db"))?;
    {
        let db = open_local(&path).await?;
        let conn = db.connect()?;
        let _mode = enable_wal(&conn).await?;
        create_block_cursor_schema(&conn).await?;
    }
    let mut child = spawn_writer(&["--path", &path, "--phase", "before-commit"])?;
    let line = wait_for_line(&mut child, "PHASE ", Duration::from_secs(20))?;
    check_eq(&line, &"PHASE before-commit")?;
    child.kill()?;
    let _status = child.wait()?;
    let (cursor, blocks) = reopen_block_cursor(&path).await?;
    check_eq(&cursor, &None)?;
    check_eq(&blocks, &0)?;
    Ok(())
}

#[tokio::test]
async fn sigkill_after_commit_keeps_block_and_cursor() -> TestResult {
    let dir = tempfile::tempdir()?;
    let path = utf8_path(&dir.path().join("gate.db"))?;
    let mut child = spawn_writer(&["--path", &path, "--phase", "after-commit"])?;
    let line = wait_for_line(&mut child, "PHASE ", Duration::from_secs(20))?;
    check_eq(&line, &"PHASE after-commit")?;
    child.kill()?;
    let _status = child.wait()?;
    let (cursor, blocks) = reopen_block_cursor(&path).await?;
    check_eq(&cursor.as_deref(), &Some("42"))?;
    check_eq(&blocks, &1)?;
    Ok(())
}

#[tokio::test]
async fn disk_full_does_not_advance_cursor() -> TestResult {
    let dir = tempfile::tempdir()?;
    let db_file = dir.path().join("gate.db");
    let path = utf8_path(&db_file)?;
    {
        let db = open_local(&path).await?;
        let conn = db.connect()?;
        let _mode = enable_wal(&conn).await?;
        create_block_cursor_schema(&conn).await?;
        let _changed = conn.execute("BEGIN IMMEDIATE", ()).await?;
        insert_block_and_cursor(&conn, 1, 100, "1").await?;
        let _changed = conn.execute("COMMIT", ()).await?;
    }

    let bin = crash_writer_bin()?;
    let output = Command::new("bash")
        .arg("-c")
        .arg("ulimit -f 256 || exit 90; exec \"$1\" --path \"$2\" --fill-bytes 4000000")
        .arg("disk-full")
        .arg(&bin)
        .arg(&path)
        .output()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    append_metric(&format!(
        "disk_full_status={} stdout={} stderr={}",
        output.status,
        stdout.trim(),
        stderr.trim()
    ))?;

    if output.status.code() == Some(90) {
        append_metric("disk_full_limitation=ulimit -f rejected")?;
        return Ok(());
    }

    if output.status.success() {
        return Err(
            format!("fill succeeded under a 256-block file size limit; stdout={stdout}").into(),
        );
    }

    let combined = format!("{stdout}\n{stderr}");
    let sigxfsz = output.status.signal() == Some(25);
    let looks_full = sigxfsz
        || combined.to_ascii_lowercase().contains("full")
        || combined.to_ascii_lowercase().contains("file too large")
        || combined.to_ascii_lowercase().contains("enospc")
        || combined.to_ascii_lowercase().contains("efbig")
        || combined.to_ascii_lowercase().contains("quota")
        || is_disk_full_error(&GateError::Message(combined.clone()));
    if !looks_full {
        return Err(format!(
            "fill failed for a reason other than disk full: status={} body={combined}",
            output.status
        )
        .into());
    }

    let (cursor, blocks) = reopen_block_cursor(&path).await?;
    check_eq(&cursor.as_deref(), &Some("1"))?;
    check_eq(&blocks, &1)?;

    let db = open_local(&path).await?;
    let conn = db.connect()?;
    let _changed = conn.execute("BEGIN IMMEDIATE", ()).await?;
    insert_block_and_cursor(&conn, 2, 112, "2").await?;
    let _changed = conn.execute("COMMIT", ()).await?;
    check_eq(&read_cursor(&conn).await?, &Some("2".to_owned()))?;
    Ok(())
}

#[tokio::test]
async fn container_syscall_restrictions_allow_commit() -> TestResult {
    let Some(server_version) = docker_server_version() else {
        append_metric("container_skipped=docker daemon unavailable")?;
        return Ok(());
    };
    append_metric(&format!("docker_server_version={server_version}"))?;

    if !python_image_present() {
        append_metric("container_limitation=python:3.12-slim-bookworm image missing")?;
        return Ok(());
    }

    let dir = tempfile::tempdir()?;
    let host_db = dir.path().join("gate.db");
    let bin = crash_writer_bin()?;
    let bin_dir = bin.parent().ok_or("missing binary directory")?;
    let bin_name = bin
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("non-UTF-8 binary name")?;

    let output = Command::new("docker")
        .args([
            "run",
            "--rm",
            "--network=none",
            "--user",
            "1000:1000",
            "--security-opt",
            "no-new-privileges",
            "--pull=never",
            "-v",
            &format!("{}:/opt/bin:ro", bin_dir.display()),
            "-v",
            &format!("{}:/data", dir.path().display()),
            "python:3.12-slim-bookworm",
            &format!("/opt/bin/{bin_name}"),
            "--path",
            "/data/gate.db",
            "--phase",
            "after-commit",
            "--exit",
        ])
        .output()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    append_metric(&format!(
        "container_status={} stdout={} stderr={}",
        output.status,
        stdout.trim(),
        stderr.trim()
    ))?;
    if !output.status.success() {
        return Err(format!("container writer failed: {stderr}{stdout}").into());
    }
    if !stdout.contains("PHASE after-commit") {
        return Err(format!("container writer missed phase marker: {stdout}").into());
    }

    let path = utf8_path(&host_db)?;
    let (cursor, blocks) = reopen_block_cursor(&path).await?;
    check_eq(&cursor.as_deref(), &Some("42"))?;
    check_eq(&blocks, &1)?;
    Ok(())
}

/// Run the complete ENOSPC scenario inside one container on a single tmpfs
/// mount, so the full-disk state and its recovery stay within that mount. The
/// container is ephemeral (`--rm`) with a unique name and no host volume, so
/// the fill cannot affect host storage. Returns combined output and status.
///
/// The database and its WAL are never removed. A separate filler file is
/// reserved before the engine fill, so the engine runs out of space against a
/// real `ENOSPC`. After the failed fill rolls back to the committed seed
/// state, only the filler is removed to free space, and a fresh write then
/// commits and is read back by a reopened handle.
fn run_enospc_scenario(
    mount_path: &str,
) -> Result<(std::process::ExitStatus, String), Box<dyn Error + Send + Sync>> {
    let bin = crash_writer_bin()?;
    let bin_dir = bin.parent().ok_or("missing binary directory")?;
    let container = format!("turso-gate-enospc-{}", unique_container_suffix());
    let bin_mount = format!("{}:/opt/bin:ro", bin_dir.display());
    let script = "set -u; \
        /opt/bin/turso_crash_writer --path /data/gate.db --seed && \
        echo SEED_DONE; \
        dd if=/dev/zero of=/data/filler.bin bs=1k count=3200 2>/dev/null; echo \"RESERVED=$?\"; \
        /opt/bin/turso_crash_writer --path /data/gate.db --fill-bytes 100000000; echo \"FILL_STATUS=$?\"; \
        /opt/bin/turso_crash_writer --path /data/gate.db --report && \
        rm -f /data/filler.bin && \
        /opt/bin/turso_crash_writer --path /data/gate.db --phase after-commit && \
        /opt/bin/turso_crash_writer --path /data/gate.db --report";
    let args = vec![
        "run",
        "--name",
        &container,
        "--rm",
        "--network=none",
        "--user",
        "1000:1000",
        "--security-opt",
        "no-new-privileges",
        "--pull=never",
        "--mount",
        mount_path,
        "-v",
        &bin_mount,
        "python:3.12-slim-bookworm",
        "/bin/sh",
        "-c",
        script,
    ];
    let output = Command::new("docker").args(&args).output()?;
    let body = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok((output.status, body))
}

/// Fill the WAL on a disposable small tmpfs until the engine reports a genuine
/// `ENOSPC`, assert the transaction rolls back to the committed seed state,
/// then free space by removing only a reserved filler file and prove a later
/// write survives a reopen. The tmpfs is an exclusive mount in an ephemeral
/// container, so no host volume can be affected. The database and its WAL are
/// never removed, so the committed seed data is retained across the failure.
#[tokio::test]
async fn enospc_tmpfs_docker_fill_rollback_and_recover() -> TestResult {
    let Some(server_version) = docker_server_version() else {
        append_metric("enospc_skipped=docker daemon unavailable")?;
        return Ok(());
    };
    append_metric(&format!("enospc_docker_server_version={server_version}"))?;
    if !python_image_present() {
        append_metric("enospc_limitation=python:3.12-slim-bookworm image missing")?;
        return Ok(());
    }

    let mount = "type=tmpfs,target=/data,tmpfs-size=4m";
    let (status, body) = run_enospc_scenario(mount)?;
    append_metric(&format!("enospc_status={status} body={}", body.trim()))?;
    if !status.success() {
        return Err(format!("ENOSPC scenario failed: status={status} body={body}").into());
    }

    // The seed wrote block 1 and cursor 1 before the fill.
    if !body.contains("SEED_DONE") {
        return Err(format!("seed step did not finish: {body}").into());
    }
    // The filler reservation must have consumed the 4 MiB tmpfs. Its exact
    // exit status is not asserted (tmpfs sizing can round), only that a real
    // ENOSPC follows from the engine fill.
    if !body.contains("RESERVED=0") {
        return Err(format!("could not reserve the filler file: {body}").into());
    }
    // Extract the fill status line: the fill must fail with a real ENOSPC.
    let fill_status = body
        .lines()
        .find(|line| line.starts_with("FILL_STATUS="))
        .ok_or("missing FILL_STATUS marker")?;
    if fill_status != "FILL_STATUS=1" {
        return Err(
            format!("fill did not fail on a 4 MiB tmpfs: {fill_status} body={body}").into(),
        );
    }
    let fill_err = body
        .lines()
        .find(|line| line.starts_with("FILL_ERROR"))
        .ok_or("missing FILL_ERROR marker")?;
    let fill_lower = fill_err.to_ascii_lowercase();
    let real_enospc = fill_lower.contains("no storage space")
        || fill_lower.contains("enospc")
        || fill_lower.contains("storage full")
        || is_disk_full_error(&GateError::Message(fill_err.to_owned()));
    if !real_enospc {
        return Err(
            format!("fill failed for a reason other than ENOSPC: {fill_err} body={body}").into(),
        );
    }

    // First report, taken while the tmpfs is still full, must show the seed
    // state (cursor 1, block 1) unchanged by the rolled-back fill.
    let first_report = body
        .lines()
        .find(|line| line.starts_with("REPORT"))
        .ok_or("missing first REPORT marker")?;
    if !first_report.contains("cursor=Some(\"1\") blocks=1") {
        return Err(format!("ENOSPC did not roll back to the seeded state: {first_report}").into());
    }

    // The final report, after only the filler is removed and a fresh write
    // commits, must show the committed seed data retained (block 1) together
    // with the recovered write (cursor 42, so two blocks total). The WAL was
    // never removed, so nothing was lost.
    let final_report = body
        .lines()
        .rfind(|line| line.starts_with("REPORT"))
        .ok_or("missing final REPORT marker")?;
    if !final_report.contains("cursor=Some(\"42\") blocks=2") {
        return Err(format!(
            "post-recovery write did not persist alongside the seed: {final_report} body={body}"
        )
        .into());
    }
    append_metric(&format!("enospc_recover_persisted={final_report}"))?;
    Ok(())
}

#[tokio::test]
async fn throughput_and_rss_smoke() -> TestResult {
    let dir = tempfile::tempdir()?;
    let path = utf8_path(&dir.path().join("gate.db"))?;
    let started = Instant::now();
    let rss_before = current_rss_kib();
    let db = open_local(&path).await?;
    let conn = db.connect()?;
    let _mode = enable_wal(&conn).await?;
    create_block_cursor_schema(&conn).await?;
    let _changed = conn.execute("BEGIN IMMEDIATE", ()).await?;
    for qblock in 1_i64..=1_000 {
        insert_block_and_cursor(&conn, qblock, 10_000 + qblock, &qblock.to_string()).await?;
    }
    let _changed = conn.execute("COMMIT", ()).await?;
    let elapsed = started.elapsed();
    let count = count_blocks(&conn).await?;
    let rss_after = current_rss_kib();
    append_metric(&format!(
        "write_1000_rows_ms={} rss_before_kib={rss_before:?} rss_after_kib={rss_after:?} count={count}",
        elapsed.as_millis()
    ))?;
    check_eq(&count, &1_000)?;
    Ok(())
}

#[test]
fn intended_backend_selection_keeps_postgres_explicit() {
    fn select(url: Option<&str>) -> Result<&'static str, &'static str> {
        match url {
            None | Some("") => Ok("turso-embedded"),
            Some(value)
                if value.starts_with("postgres://") || value.starts_with("postgresql://") =>
            {
                Ok("sqlx-postgres")
            }
            Some(_) => Err("malformed nonempty DATABASE_URL"),
        }
    }
    assert_eq!(select(None).ok(), Some("turso-embedded"));
    assert_eq!(select(Some("")).ok(), Some("turso-embedded"));
    assert_eq!(
        select(Some("postgres://example/db")).ok(),
        Some("sqlx-postgres")
    );
    assert_eq!(
        select(Some("postgresql://example/db")).ok(),
        Some("sqlx-postgres")
    );
    assert_eq!(
        select(Some("sqlite:memory")).err(),
        Some("malformed nonempty DATABASE_URL")
    );
}
