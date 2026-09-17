// SPDX-License-Identifier: AGPL-3.0-or-later
//! Required backend tasks, cancellation, and bounded shutdown.
use std::{collections::HashMap, future::Future, time::Duration};
use tokio::{
    task::{Id, JoinError, JoinSet},
    time::{Instant, timeout_at},
};
use tokio_util::sync::CancellationToken;

/// Backend shutdown always preserves a worker or cleanup failure.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct LifecycleError(String);

/// Owns every required task and awaits cancellation before closing storage.
pub struct TaskSupervisor {
    tasks: JoinSet<(&'static str, Result<(), String>)>,
    names: HashMap<Id, &'static str>,
    cancellation: CancellationToken,
}
impl TaskSupervisor {
    /// Use one cancellation token for network waits and admission.
    #[must_use]
    pub fn new(cancellation: CancellationToken) -> Self {
        Self {
            tasks: JoinSet::new(),
            names: HashMap::new(),
            cancellation,
        }
    }
    /// Register a task before entering the supervision loop.
    pub fn spawn(
        &mut self,
        name: &'static str,
        future: impl Future<Output = Result<(), String>> + Send + 'static,
    ) {
        let handle = self.tasks.spawn(async move { (name, future.await) });
        let _ = self.names.insert(handle.id(), name);
    }
    /// Await a shutdown signal or worker exit, then drain and close within one deadline.
    /// `on_exit` marks failed required tasks dead immediately, before draining siblings.
    ///
    /// # Errors
    /// Returns unexpected worker exits, signal failures, drain timeouts, or close failures.
    pub async fn run(
        mut self,
        signal: impl Future<Output = Result<(), String>>,
        shutdown_budget: Duration,
        mut on_exit: impl FnMut(&'static str),
        close: impl Future<Output = Result<(), String>>,
    ) -> Result<(), LifecycleError> {
        let mut failure = tokio::select! {
            biased;
            result = self.tasks.join_next(), if !self.tasks.is_empty() => {
                result.map(|result| self.failure(result, &mut on_exit, true))
            }
            result = signal => result.err(),
        };
        self.cancellation.cancel();
        let deadline = Instant::now() + shutdown_budget;
        let reserve = (shutdown_budget / 4).min(Duration::from_secs(2));
        let drain = async {
            while let Some(result) = self.tasks.join_next().await {
                match &result {
                    Ok((_, Ok(()))) => {}
                    Ok((_, Err(_))) | Err(_) => {
                        let message = self.failure(result, &mut on_exit, false);
                        let _ = failure.get_or_insert(message);
                    }
                }
            }
        };
        if timeout_at(deadline - reserve, drain).await.is_err() {
            let _ = failure
                .get_or_insert_with(|| "required task drain exceeded shutdown deadline".into());
            self.tasks.abort_all();
            // Aborted futures must release transaction guards before store close.
            let joined = timeout_at(deadline, async {
                while self.tasks.join_next().await.is_some() {}
            })
            .await;
            if joined.is_err() {
                return Err(LifecycleError(
                    failure.unwrap_or_else(|| "task abort timed out".into()),
                ));
            }
        }
        match timeout_at(deadline, close).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                let _ = failure.get_or_insert_with(|| format!("store close: {error}"));
            }
            Err(_) => {
                let _ =
                    failure.get_or_insert_with(|| "store close exceeded shutdown deadline".into());
            }
        }
        failure.map_or(Ok(()), |error| Err(LifecycleError(error)))
    }
    fn failure(
        &self,
        result: Result<(&'static str, Result<(), String>), JoinError>,
        on_exit: &mut impl FnMut(&'static str),
        unexpected: bool,
    ) -> String {
        match result {
            Ok((name, result)) => {
                on_exit(name);
                match result {
                    Ok(()) => format!("required task {name} exited unexpectedly"),
                    Err(error) => format!("required task {name} failed: {error}"),
                }
            }
            Err(error) => {
                let name = self.names.get(&error.id()).copied().unwrap_or("unknown");
                if unexpected || !error.is_cancelled() {
                    on_exit(name);
                }
                format!("required task {name} could not be joined: {error}")
            }
        }
    }
}

/// Wait for SIGTERM or Ctrl-C without spawning a detached signal listener.
///
/// # Errors
/// Returns signal registration or delivery errors.
#[cfg(unix)]
pub async fn shutdown_signal() -> Result<(), String> {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(|error| error.to_string())?;
    tokio::select! {
        result = tokio::signal::ctrl_c() => result.map_err(|error| error.to_string()),
        signal = terminate.recv() => signal.ok_or_else(|| "SIGTERM listener closed".into()),
    }
}

/// Persistence errors keep database failures distinct from temporary miner outages.
#[derive(Debug, thiserror::Error)]
pub enum MinerPersistenceError {
    /// A serialized database operation failed.
    #[error(transparent)]
    Store(#[from] dashboard_store::StoreError),
    /// Miner data cannot satisfy the persisted model contract.
    #[error(transparent)]
    Invalid(#[from] serde_json::Error),
    /// The miner request failed without proving a sparse gap.
    #[error(transparent)]
    Upstream(#[from] crate::miner::parse::MinerError),
}

/// Persist one local miner poll and return only its freshly confirmed identity.
/// A failed status request never assigns another account's hardware to the local miner.
///
/// # Errors
/// Returns invalid miner fields or a persistence failure.
pub async fn persist_miner_poll(
    store: &dashboard_store::Store,
    status: Option<&crate::miner::parse::NodeStatus>,
    stats: Option<&crate::miner::parse::MinerStats>,
    observed_at: &str,
) -> Result<Option<String>, MinerPersistenceError> {
    use dashboard_model::{
        IndexerObservability, MinerCategory, MinerHardwareRecord, MinerHardwareSource,
    };
    let mut observability =
        store
            .get_indexer_observability()
            .await?
            .unwrap_or_else(|| IndexerObservability {
                chain_head_from_node: None,
                last_status_fetch_at: String::new(),
                last_block_insert_at: None,
                last_substrate_event_at: None,
                best_block_height: None,
                finalized_block_height: None,
                chain_connected: false,
                node_syncing: None,
                node_sync_current_block: None,
                node_sync_highest_block: None,
                self_identified: Some(false),
                miner_stats: None,
                modes: None,
                indexer: None,
                device_access_time_backfill: None,
            });
    // This legacy field records poll attempts. Health separately records successful polls.
    observed_at.clone_into(&mut observability.last_status_fetch_at);
    observability.self_identified = Some(false);
    let mut identity = None;
    if let Some(status) = status.filter(|status| !status.ss58_address.trim().is_empty()) {
        let miners: Vec<dashboard_model::MinerHandle> = project(&status.miners)?;
        let primary_type = [MinerCategory::Gpu, MinerCategory::Qpu, MinerCategory::Cpu]
            .into_iter()
            .find(|category| miners.iter().any(|miner| miner.miner_type == *category))
            .unwrap_or(MinerCategory::Other);
        let hardware = MinerHardwareRecord {
            account_id: status.ss58_address.clone(),
            node_id: status.node_id.clone(),
            miners,
            primary_type,
            source: MinerHardwareSource::SelfAccount,
            observed_at: observed_at.into(),
        };
        let head: dashboard_model::DecimalString = project(&status.chain_head_number.to_string())?;
        let modes = project(&status.modes)?;
        store.upsert_miner_hardware(&hardware).await?;
        store.set_self_address(Some(&status.ss58_address)).await?;
        observability.self_identified = Some(true);
        observability.chain_head_from_node = Some(head);
        observability.modes = Some(modes);
        identity = Some(status.ss58_address.clone());
    }
    if let Some(stats) = stats {
        observability.miner_stats = Some(project(stats)?);
    }
    store.set_indexer_observability(&observability).await?;
    Ok(identity)
}

/// Select at most 25 completed solutions, retaining the legacy 200-solution lookback.
/// `highest_completed` comes from the indexed chain's `qblock_count`, never miner stats.
///
/// # Errors
/// Returns a checkpoint read/write failure.
pub async fn mining_catchup_range(
    store: &dashboard_store::Store,
    account: &str,
    highest_completed: u64,
) -> Result<Vec<u64>, dashboard_store::StoreError> {
    let mut checkpoint = store.get_mining_checkpoint(account).await?.unwrap_or(0);
    let floor = highest_completed.saturating_sub(200);
    if checkpoint < floor {
        store.set_mining_checkpoint(account, floor).await?;
        checkpoint = floor;
    }
    if checkpoint >= highest_completed {
        return Ok(Vec::new());
    }
    let through = checkpoint.saturating_add(25).min(highest_completed);
    Ok((checkpoint + 1..=through).collect())
}

/// Atomically persist a completed local submission and advance its checkpoint.
/// A proven 404 or malformed miner body advances as an explicit logged gap.
///
/// # Errors
/// Returns temporary upstream errors without advancing, or any database failure.
pub async fn persist_mining_attempt(
    store: &dashboard_store::Store,
    account: &str,
    solution: u64,
    observed_at: &str,
    result: Result<crate::miner::parse::MiningSubmissionRecord, crate::miner::parse::MinerError>,
) -> Result<(), MinerPersistenceError> {
    use crate::miner::parse::MinerError;
    let mut records = Vec::with_capacity(1);
    match result {
        Ok(submission) => match project::<dashboard_model::MiningSubmissionRecord>(&submission) {
            Ok(mut row) if row.solution_number == solution => {
                account.clone_into(&mut row.miner_id);
                observed_at.clone_into(&mut row.observed_at);
                records.push(row);
            }
            Ok(_) => tracing::warn!(
                solution,
                "miner returned a different solution number; recording a gap"
            ),
            Err(error) => {
                tracing::warn!(solution, %error, "miner submission cannot become a row; recording a gap");
            }
        },
        Err(MinerError::NotFound(_)) => {
            tracing::debug!(solution, "miner has no submission for completed solution");
        }
        Err(MinerError::Unparsable(error)) => {
            tracing::warn!(solution, %error, "unparsable miner submission; recording a gap");
        }
        Err(error) => return Err(error.into()),
    }
    store
        .commit_mining_submissions(account, &records, solution)
        .await?;
    Ok(())
}

fn project<T: serde::de::DeserializeOwned>(
    source: &impl serde::Serialize,
) -> Result<T, serde_json::Error> {
    serde_json::from_value(serde_json::to_value(source)?)
}

/// One-shot device-access-time backfill: reindex winners when every indexed
/// winner row predates migration 0006 and none reports access time.
///
/// This mirrors the prior TypeScript one-shot (`ensureDeviceAccessTimeBackfill`)
/// which ran after migrations, before the indexer workers started. The durable
/// marker is the point, not the probe: the field is self-reported and usually
/// absent, so "every row is null" is a legitimate steady state. Only the first
/// boot against a marker-less store may decide, and the decision must stick
/// across restarts and crashes. The marker is written BEFORE the reindex, so a
/// crash mid-reindex never schedules a second generation bump on restart; the
/// cleared coverage and idempotent re-walk complete the recovery.
///
/// The decision is surfaced through the persisted observability snapshot, which
/// the API returns as `deviceAccessTimeBackfill`.
///
/// # Errors
/// Returns persistence or validation errors.
pub async fn ensure_device_access_time_backfill(
    store: &dashboard_store::Store,
) -> Result<Option<dashboard_model::DeviceAccessTimeBackfill>, dashboard_store::StoreError> {
    use dashboard_model::DeviceAccessTimeBackfill as Decision;
    let decision = if let Some(marker) = store.get_device_access_time_backfill_marker().await? {
        if marker == "not-needed" {
            Some(Decision::NotNeeded)
        } else {
            Some(Decision::Triggered)
        }
    } else {
        let probe = store.probe_device_access_time_data().await?;
        if !probe.has_blocks || probe.has_reported {
            store
                .set_device_access_time_backfill_marker("not-needed")
                .await?;
            Some(Decision::NotNeeded)
        } else {
            store
                .set_device_access_time_backfill_marker("triggered")
                .await?;
            tracing::info!(
                "[indexer] device_access_time_us missing on every indexed winner row — scheduling one-shot winners reindex to backfill"
            );
            let _ = store
                .reindex(&[dashboard_store::Indexable::Winners])
                .await?;
            Some(Decision::Triggered)
        }
    };
    if let Some(decision) = decision {
        let mut observability = store.get_indexer_observability().await?.unwrap_or_else(|| {
            use dashboard_model::IndexerObservability;
            IndexerObservability {
                chain_head_from_node: None,
                last_status_fetch_at: String::new(),
                last_block_insert_at: None,
                last_substrate_event_at: None,
                best_block_height: None,
                finalized_block_height: None,
                chain_connected: false,
                node_syncing: None,
                node_sync_current_block: None,
                node_sync_highest_block: None,
                self_identified: Some(false),
                miner_stats: None,
                modes: None,
                indexer: None,
                device_access_time_backfill: None,
            }
        });
        observability.device_access_time_backfill = Some(decision);
        store.set_indexer_observability(&observability).await?;
    }
    Ok(decision)
}

/// Project persisted domain coverage without adding chain RPC requests.
/// `queued` counts waiting scheduler work, excluding workers already executing.
///
/// # Errors
/// Returns persistence errors or an invalid persisted gap range.
pub async fn coverage_progress(
    store: &dashboard_store::Store,
    queued: u64,
) -> Result<dashboard_model::IndexerBackfillProgress, dashboard_store::StoreError> {
    use dashboard_store::{Indexable, StoreError};
    let mut coverage = std::collections::BTreeMap::new();
    let mut difficulty_data_start_block = None;
    for domain in [
        Indexable::Winners,
        Indexable::Difficulty,
        Indexable::Participation,
        Indexable::Authorship,
    ] {
        let stored = store.coverage(domain).await?;
        let generation = store.generation(domain).await?;
        let mut gaps = 0_u64;
        if let Some(stored) = &stored {
            for [from, through] in &stored.gaps {
                gaps = through
                    .checked_sub(*from)
                    .and_then(|count| count.checked_add(1))
                    .and_then(|count| gaps.checked_add(count))
                    .ok_or_else(|| StoreError::Invalid("coverage gap count exceeds u64".into()))?;
            }
            if domain == Indexable::Difficulty {
                difficulty_data_start_block = Some(stored.start.into());
            }
        }
        let _ = coverage.insert(
            domain.name().into(),
            dashboard_model::IndexerPluginCoverage {
                low: stored.as_ref().and_then(|row| row.low).map(Into::into),
                high: stored.as_ref().and_then(|row| row.high).map(Into::into),
                gap_blocks: gaps,
                pruned_floor: stored
                    .as_ref()
                    .and_then(|row| row.pruned_floor)
                    .map(Into::into),
                topology_enrichment_floor: None,
                generation,
            },
        );
    }
    Ok(dashboard_model::IndexerBackfillProgress {
        backfill_queue_depth: queued,
        coverage,
        difficulty_data_start_block,
        backfill_eta_seconds: Some(None),
    })
}
