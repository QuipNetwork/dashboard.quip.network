// SPDX-License-Identifier: AGPL-3.0-or-later

//! Subprocess writer for crash and disk-full qualification cases.
//!
//! Usage:
//! `turso_crash_writer --path PATH --phase before-commit|after-commit [--exit]`
//! `turso_crash_writer --path PATH --fill-bytes N`
//! `turso_crash_writer --path PATH --seed`
//! `turso_crash_writer --path PATH --report`

use std::io::{self, Read, Write};

use anyhow::{bail, Context};
use turso_gate::{
    count_blocks, create_block_cursor_schema, enable_wal, insert_block_and_cursor, open_local,
    read_cursor,
};

struct Args {
    path: String,
    phase: Option<String>,
    exit_after_phase: bool,
    fill_bytes: Option<u64>,
    seed: bool,
    report: bool,
}

fn parse_args() -> anyhow::Result<Args> {
    let mut path = None;
    let mut phase = None;
    let mut exit_after_phase = false;
    let mut fill_bytes = None;
    let mut seed = false;
    let mut report = false;
    let mut argv = std::env::args().skip(1);
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--path" => {
                path = Some(argv.next().context("missing --path value")?);
            }
            "--phase" => {
                phase = Some(argv.next().context("missing --phase value")?);
            }
            "--exit" => exit_after_phase = true,
            "--fill-bytes" => {
                let raw = argv.next().context("missing --fill-bytes value")?;
                fill_bytes = Some(raw.parse::<u64>().context("invalid --fill-bytes")?);
            }
            "--seed" => seed = true,
            "--report" => report = true,
            other => bail!("unknown argument: {other}"),
        }
    }
    let path = path.context("missing --path")?;
    let modes = u8::from(phase.is_some())
        + u8::from(fill_bytes.is_some())
        + u8::from(seed)
        + u8::from(report);
    if modes != 1 {
        bail!("choose exactly one of --phase, --fill-bytes, --seed, or --report");
    }
    if let Some(name) = phase.as_deref() {
        if name != "before-commit" && name != "after-commit" {
            bail!("--phase must be before-commit or after-commit");
        }
    }
    Ok(Args {
        path,
        phase,
        exit_after_phase,
        fill_bytes,
        seed,
        report,
    })
}

fn emit(line: &str) -> anyhow::Result<()> {
    let mut out = io::stdout().lock();
    writeln!(out, "{line}")?;
    out.flush()?;
    Ok(())
}

fn wait_until_killed() -> anyhow::Result<()> {
    let mut buf = [0_u8; 1];
    let _n = io::stdin().read(&mut buf)?;
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = parse_args()?;
    let db = open_local(&args.path)
        .await
        .map_err(|err| anyhow::anyhow!("{err}"))?;
    let conn = db.connect().map_err(|err| anyhow::anyhow!("{err}"))?;
    let mode = enable_wal(&conn)
        .await
        .map_err(|err| anyhow::anyhow!("{err}"))?;
    if !mode.eq_ignore_ascii_case("wal") {
        bail!("journal_mode is {mode}, expected wal");
    }
    create_block_cursor_schema(&conn)
        .await
        .map_err(|err| anyhow::anyhow!("{err}"))?;

    if args.seed {
        seed_database(&conn).await?;
        return Ok(());
    }
    if args.report {
        report_state(&conn).await?;
        return Ok(());
    }
    if let Some(fill_bytes) = args.fill_bytes {
        fill_until(&conn, fill_bytes).await?;
        return Ok(());
    }

    let phase = args.phase.context("missing --phase")?;
    let _changed = conn
        .execute("BEGIN IMMEDIATE", ())
        .await
        .map_err(|err| anyhow::anyhow!("{err}"))?;
    insert_block_and_cursor(&conn, 42, 1_700_000_042, "42")
        .await
        .map_err(|err| anyhow::anyhow!("{err}"))?;
    if phase == "after-commit" {
        let _changed = conn
            .execute("COMMIT", ())
            .await
            .map_err(|err| anyhow::anyhow!("{err}"))?;
        conn.cacheflush().map_err(|err| anyhow::anyhow!("{err}"))?;
    }
    emit(&format!("PHASE {phase}"))?;
    if args.exit_after_phase {
        return Ok(());
    }
    wait_until_killed()?;
    Ok(())
}

/// Write a durable baseline block and cursor, then checkpoint into the main
/// database file so the seed survives deletion of the WAL.
async fn seed_database(conn: &turso::Connection) -> anyhow::Result<()> {
    let _changed = conn
        .execute("BEGIN IMMEDIATE", ())
        .await
        .map_err(|err| anyhow::anyhow!("{err}"))?;
    insert_block_and_cursor(conn, 1, 100, "1")
        .await
        .map_err(|err| anyhow::anyhow!("{err}"))?;
    let _changed = conn
        .execute("COMMIT", ())
        .await
        .map_err(|err| anyhow::anyhow!("{err}"))?;
    conn.cacheflush().map_err(|err| anyhow::anyhow!("{err}"))?;
    let _ = conn.query("PRAGMA wal_checkpoint(TRUNCATE)", ()).await;
    emit("SEED_OK")?;
    Ok(())
}

/// Print the current cursor and block count for the caller to parse.
async fn report_state(conn: &turso::Connection) -> anyhow::Result<()> {
    let cursor = read_cursor(conn)
        .await
        .map_err(|err| anyhow::anyhow!("{err}"))?;
    let blocks = count_blocks(conn)
        .await
        .map_err(|err| anyhow::anyhow!("{err}"))?;
    emit(&format!("REPORT cursor={cursor:?} blocks={blocks}"))?;
    Ok(())
}

async fn fill_until(conn: &turso::Connection, fill_bytes: u64) -> anyhow::Result<()> {
    let _changed = conn
        .execute(
            "CREATE TABLE IF NOT EXISTS blobs (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)",
            (),
        )
        .await
        .map_err(|err| anyhow::anyhow!("{err}"))?;
    let _changed = conn
        .execute("BEGIN IMMEDIATE", ())
        .await
        .map_err(|err| anyhow::anyhow!("{err}"))?;
    let chunk = vec![0x61_u8; 8192];
    let mut written = 0_u64;
    let mut id = 1_i64;
    while written < fill_bytes {
        match conn
            .execute(
                "INSERT INTO blobs (id, payload) VALUES (?1, ?2)",
                (id, chunk.as_slice()),
            )
            .await
        {
            Ok(_) => {
                written = written.saturating_add(chunk.len() as u64);
                id = id.saturating_add(1);
            }
            Err(err) => {
                let _ = conn.execute("ROLLBACK", ()).await;
                emit(&format!("FILL_ERROR {err}"))?;
                bail!("{err}");
            }
        }
    }
    insert_block_and_cursor(conn, 7, 112, "7")
        .await
        .map_err(|err| anyhow::anyhow!("{err}"))?;
    match conn.execute("COMMIT", ()).await {
        Ok(_) => {
            emit("FILL_OK")?;
            let cursor = read_cursor(conn)
                .await
                .map_err(|err| anyhow::anyhow!("{err}"))?;
            let blocks = count_blocks(conn)
                .await
                .map_err(|err| anyhow::anyhow!("{err}"))?;
            emit(&format!("CURSOR {cursor:?} BLOCKS {blocks}"))?;
            Ok(())
        }
        Err(err) => {
            let _ = conn.execute("ROLLBACK", ()).await;
            emit(&format!("FILL_ERROR {err}"))?;
            bail!("{err}");
        }
    }
}
