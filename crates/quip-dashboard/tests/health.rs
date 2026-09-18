// SPDX-License-Identifier: AGPL-3.0-or-later
//! Task death, readiness, and monotonic stale-progress checks.
use quip_dashboard::health::{HealthState, Phase, RequiredTask};
use std::time::Duration;

fn ready() -> HealthState {
    let health = HealthState::new(true);
    health.set_phase(Phase::Ready);
    health.connected(true);
    health.head_received(Some(10), Some(10));
    health.committed(10);
    health.miner_success("2026-09-16T00:00:00.000Z");
    health
}
#[tokio::test]
async fn required_task_exit_fails_liveness_even_after_successful_work() {
    let health = ready();
    assert!(health.snapshot().ready);
    health.task_exited(RequiredTask::Indexer);
    assert!(!health.snapshot().live);
    assert!(!health.snapshot().ready);
}
#[tokio::test]
async fn validator_outage_is_unready_but_live() {
    let health = ready();
    health.connected(false);
    assert!(health.snapshot().live);
    assert!(!health.snapshot().ready);
}
#[tokio::test(start_paused = true)]
async fn advancing_heads_without_commits_fail_readiness_after_ninety_seconds() {
    let health = ready();
    health.head_received(Some(11), Some(11));
    tokio::time::advance(Duration::from_secs(91)).await;
    health.heartbeat(RequiredTask::Watchdog);
    health.miner_success("2026-09-16T00:01:31.000Z");
    health.head_received(Some(25), Some(25));
    assert!(health.snapshot().live);
    assert!(!health.snapshot().ready);
    assert!(
        health
            .snapshot()
            .reasons
            .iter()
            .any(|reason| reason.contains("commit"))
    );
    health.committed(25);
    assert!(health.snapshot().ready);
}
#[tokio::test(start_paused = true)]
async fn steady_empty_chain_and_no_winner_do_not_fail_readiness() {
    let health = HealthState::new(true);
    health.set_phase(Phase::Ready);
    health.connected(true);
    health.head_received(Some(0), Some(0));
    health.committed(0);
    tokio::time::advance(Duration::from_secs(1000)).await;
    health.heartbeat(RequiredTask::Watchdog);
    health.miner_success("2026-09-16T00:16:40.000Z");
    assert!(health.snapshot().ready);
}
#[tokio::test(start_paused = true)]
async fn startup_and_watchdog_stalls_have_finite_liveness_limits() {
    let health = HealthState::new(true);
    tokio::time::advance(Duration::from_secs(59)).await;
    assert!(health.snapshot().live);
    tokio::time::advance(Duration::from_secs(2)).await;
    assert!(!health.snapshot().live);
    let health = ready();
    tokio::time::advance(Duration::from_secs(16)).await;
    assert!(!health.snapshot().live);
}
#[tokio::test]
async fn api_only_does_not_require_indexer_miner_or_chain() {
    let health = HealthState::new(false);
    health.set_phase(Phase::Ready);
    health.task_exited(RequiredTask::Indexer);
    health.task_exited(RequiredTask::Miner);
    assert!(health.snapshot().ready);
    assert!(health.snapshot().live);
}
#[tokio::test(start_paused = true)]
async fn repeated_cached_miner_timestamp_does_not_refresh_success_age() {
    let health = ready();
    tokio::time::advance(Duration::from_secs(91)).await;
    health.heartbeat(RequiredTask::Watchdog);
    health.miner_success("2026-09-16T00:00:00.000Z");
    assert!(!health.snapshot().ready);
}
