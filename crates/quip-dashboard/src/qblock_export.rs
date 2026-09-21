// SPDX-License-Identifier: AGPL-3.0-or-later
//! Republish qblock files from the store.
//!
//! The indexer writes these files as it commits. A deployment that runs no
//! indexer (`RUN_INDEXER=false`) still serves the same views, so it rebuilds
//! the same files from the shared database on a timer. Both callers use the
//! functions here, so the two paths cannot drift.

use crate::indexer::file_writer::FileWriter;
use dashboard_store::Store;

/// Qblocks listed in `metadata.json` for the client's first load. Older
/// qblocks stay on disk and are listed in per-day history manifests.
pub const RECENT_DAYS: i64 = 14;
/// Qblocks younger than this are left to the live writer, which may still be
/// committing their participation pages.
const RESTORE_MIN_AGE_SECS: u64 = 300;

/// Recreate qblock files missing for winners at or after `since` from the
/// store. Covers qblocks indexed before file-backed storage existed and
/// best-effort live writes that failed. Errors are logged; returns whether
/// every qblock was checked without error.
pub async fn restore_qblock_files(store: &Store, writer: &FileWriter, since: i64) -> bool {
    let winners = match store.get_blocks_since(since).await {
        Ok(winners) => winners,
        Err(error) => {
            tracing::warn!(%error, "qblock file restore query failed");
            return false;
        }
    };
    let mut complete = true;
    let settled = u64::try_from(chrono::Utc::now().timestamp())
        .unwrap_or(0)
        .saturating_sub(RESTORE_MIN_AGE_SECS);
    let mut restored = 0_usize;
    for winner in winners.iter().filter(|w| w.timestamp <= settled) {
        // Most files exist; skip their participation query.
        match writer.has_qblock(winner.qblock_id.as_str()).await {
            Ok(true) => continue,
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(%error, qblock = winner.qblock_id.as_str(), "qblock file check failed");
                complete = false;
                continue;
            }
        }
        let participation = match store
            .get_qblock_participation(winner.qblock_id.as_str())
            .await
        {
            Ok(rows) => rows,
            Err(error) => {
                tracing::warn!(%error, qblock = winner.qblock_id.as_str(), "qblock participation query failed");
                complete = false;
                continue;
            }
        };
        match writer.restore_qblock(winner, &participation).await {
            Ok(true) => restored += 1,
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(%error, qblock = winner.qblock_id.as_str(), "qblock file restore failed");
                complete = false;
            }
        }
    }
    if restored > 0 {
        tracing::info!(restored, "restored missing qblock files");
    }
    complete
}

/// One sweep per hour, matching the indexer's own maintenance cadence.
const EXPORT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3600);

/// Republish qblock files and manifests from the store until cancelled.
///
/// A deployment with no indexer runs this so its file tree matches what the
/// indexer would have written. Each replica owns its own file tree: only the
/// database is shared, so two processes never merge the same qblock file.
///
/// # Errors
/// Never returns an error. The signature matches what the task supervisor
/// accepts; a sweep that fails is logged and retried on the next tick, since
/// the database being briefly unreachable is not a reason to end the process.
pub async fn run_qblock_export(
    store: std::sync::Arc<Store>,
    writer: FileWriter,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<(), String> {
    let mut ticker = tokio::time::interval(EXPORT_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Sweep all of history on the first pass, then narrow to the recent
    // window once a full pass has succeeded, exactly as the indexer does.
    let mut restore_since = 0;
    loop {
        tokio::select! {
            () = cancellation.cancelled() => return Ok(()),
            _ = ticker.tick() => {
                let recent_since = chrono::Utc::now().timestamp() - RECENT_DAYS * 86_400;
                if restore_qblock_files(&store, &writer, restore_since).await {
                    restore_since = recent_since;
                }
                if let Err(error) = writer.rebuild_manifests(recent_since).await {
                    tracing::warn!(%error, "qblock manifest rebuild failed");
                }
            }
        }
    }
}
