// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared monotonic task liveness and upstream readiness.
use serde::Serialize;
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::Instant;

/// Tasks whose unexpected termination must end the backend.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum RequiredTask {
    /// HTTP listener.
    Http,
    /// Finalized indexing and reconciliation.
    Indexer,
    /// Local miner polling and persistence.
    Miner,
    /// Independent scheduler watchdog.
    Watchdog,
}
/// Local startup and verified service phases.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Opening and migrating the database.
    LocalStartup,
    /// Connecting to a selected validator.
    Connecting,
    /// Checking retained history against the selected chain.
    Verifying,
    /// Local initialization has completed.
    Ready,
    /// Admission has stopped for shutdown.
    Stopping,
}
/// Compatible health fields plus explicit live/ready decisions.
#[derive(Clone, Debug, Serialize)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "the public health contract exposes independent liveness, readiness, route status, and connection fields"
)]
#[serde(rename_all = "camelCase")]
pub struct HealthSnapshot {
    /// Readiness by default. The live route sets this to `live`.
    pub ok: bool,
    /// Required tasks and watchdog are alive.
    pub live: bool,
    /// Configured dependencies and progress checks are healthy.
    pub ready: bool,
    /// Current service phase.
    pub phase: Phase,
    /// Last successful miner status fetch, in UTC.
    pub last_status_fetch_at: Option<String>,
    /// Last advancing finalized commit, in UTC.
    pub last_block_insert_at: Option<String>,
    /// Last observed head event, in UTC.
    pub last_substrate_event_at: Option<String>,
    /// Active finalized subscription state.
    pub chain_connected: bool,
    /// Highest observed best height, as a decimal string.
    pub best_block_height: Option<String>,
    /// Highest observed finalized height, as a decimal string.
    pub finalized_block_height: Option<String>,
    /// Highest durably committed finalized height, as a decimal string.
    pub last_committed_height: Option<String>,
    /// Concrete reasons for failed checks.
    pub reasons: Vec<String>,
}
struct State {
    indexing: bool,
    phase: Phase,
    started: Instant,
    watchdog: Instant,
    dead: BTreeSet<RequiredTask>,
    connected: bool,
    best: Option<u64>,
    finalized: Option<u64>,
    committed: Option<u64>,
    waiting: Option<Instant>,
    miner_success: Option<Instant>,
    miner_utc: Option<String>,
    commit_utc: Option<String>,
    head_utc: Option<String>,
}
/// Clones share the same task and progress observations.
#[derive(Clone)]
pub struct HealthState(Arc<Mutex<State>>);
impl HealthState {
    /// Register the required tasks for normal or API-only operation.
    #[must_use]
    pub fn new(indexing: bool) -> Self {
        Self(Arc::new(Mutex::new(State {
            indexing,
            phase: Phase::LocalStartup,
            started: Instant::now(),
            watchdog: Instant::now(),
            dead: BTreeSet::new(),
            connected: false,
            best: None,
            finalized: None,
            committed: None,
            waiting: None,
            miner_success: None,
            miner_utc: None,
            commit_utc: None,
            head_utc: None,
        })))
    }
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    /// Change the local startup or shutdown phase.
    pub fn set_phase(&self, phase: Phase) {
        self.state().phase = phase;
    }
    /// Record an independent watchdog tick.
    pub fn heartbeat(&self, task: RequiredTask) {
        if task == RequiredTask::Watchdog {
            self.state().watchdog = Instant::now();
        }
    }
    /// Record an unexpected required-task exit, including successful exits.
    pub fn task_exited(&self, task: RequiredTask) {
        let mut state = self.state();
        if state.indexing || task == RequiredTask::Http || task == RequiredTask::Watchdog {
            let _ = state.dead.insert(task);
        }
    }
    /// Update active chain subscription state without counting it as a commit.
    pub fn connected(&self, connected: bool) {
        self.state().connected = connected;
    }
    /// Record a received head. Repeated heights do not reset stalled-work time.
    pub fn head_received(&self, best: Option<u64>, finalized: Option<u64>) {
        let mut state = self.state();
        state.head_utc = Some(now());
        if let Some(best) = best {
            state.best = Some(state.best.map_or(best, |prior| prior.max(best)));
        }
        if let Some(finalized) = finalized {
            state.finalized = Some(
                state
                    .finalized
                    .map_or(finalized, |prior| prior.max(finalized)),
            );
        }
        if state.finalized.unwrap_or(0) > state.committed.unwrap_or(0) && state.waiting.is_none() {
            state.waiting = Some(Instant::now());
        }
    }
    /// Record durable progress. Winner age is deliberately absent from readiness.
    pub fn committed(&self, height: u64) {
        let mut state = self.state();
        if state.committed.is_none_or(|prior| height > prior) {
            state.committed = Some(height);
            state.commit_utc = Some(now());
            state.waiting = if state.finalized.unwrap_or(0) > height {
                Some(Instant::now())
            } else {
                None
            };
        }
    }
    /// Record a successful fetch. Repeated cached timestamps do not refresh age.
    pub fn miner_success(&self, observed_at: &str) {
        let mut state = self.state();
        if state.miner_utc.as_deref() != Some(observed_at) {
            state.miner_success = Some(Instant::now());
            state.miner_utc = Some(observed_at.into());
        }
    }
    /// Evaluate health using monotonic time and expose UTC timestamps for clients.
    #[must_use]
    pub fn snapshot(&self) -> HealthSnapshot {
        let state = self.state();
        let mut reasons = Vec::new();
        for task in &state.dead {
            reasons.push(format!("required task {task:?} exited"));
        }
        if state.phase == Phase::LocalStartup {
            if state.started.elapsed() > Duration::from_secs(60) {
                reasons.push("local startup exceeded 60 seconds".into());
            }
        } else if state.watchdog.elapsed() > Duration::from_secs(15) {
            reasons.push("watchdog has not progressed for 15 seconds".into());
        }
        let live = reasons.is_empty();
        if state.phase != Phase::Ready {
            reasons.push(format!("service phase is {:?}", state.phase));
        }
        if state.indexing {
            if !state.connected {
                reasons.push("validator subscription unavailable".into());
            }
            if state
                .waiting
                .is_some_and(|since| since.elapsed() > Duration::from_secs(90))
            {
                reasons.push(
                    "finalized heads advance without committed progress for 90 seconds".into(),
                );
            }
            if state
                .miner_success
                .is_none_or(|since| since.elapsed() > Duration::from_secs(90))
            {
                reasons.push("no recent successful miner poll".into());
            }
        }
        let ready = reasons.is_empty();
        HealthSnapshot {
            ok: ready,
            live,
            ready,
            phase: state.phase,
            last_status_fetch_at: state.miner_utc.clone(),
            last_block_insert_at: state.commit_utc.clone(),
            last_substrate_event_at: state.head_utc.clone(),
            chain_connected: state.connected,
            best_block_height: state.best.map(|h| h.to_string()),
            finalized_block_height: state.finalized.map(|h| h.to_string()),
            last_committed_height: state.committed.map(|h| h.to_string()),
            reasons,
        }
    }
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
