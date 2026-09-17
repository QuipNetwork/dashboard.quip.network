// SPDX-License-Identifier: AGPL-3.0-or-later
//! Required worker failure and bounded shutdown contracts.
#![expect(
    clippy::panic_in_result_fn,
    reason = "Integration tests assert behavior while propagating setup and IO errors"
)]
use quip_dashboard::lifecycle::TaskSupervisor;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn successful_unexpected_exit_cancels_siblings_and_still_closes() {
    let cancellation = CancellationToken::new();
    let sibling = cancellation.clone();
    let stopped = Arc::new(AtomicBool::new(false));
    let observed = stopped.clone();
    let mut tasks = TaskSupervisor::new(cancellation);
    tasks.spawn("indexer", async { Ok(()) });
    tasks.spawn("miner", async move {
        sibling.cancelled().await;
        observed.store(true, Ordering::SeqCst);
        Ok(())
    });
    let closed = AtomicBool::new(false);
    let mut deaths = Vec::new();
    let result = tasks
        .run(
            std::future::pending(),
            Duration::from_secs(1),
            |name| deaths.push(name),
            async {
                closed.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;
    assert!(result.is_err());
    assert_eq!(deaths, ["indexer"]);
    assert!(stopped.load(Ordering::SeqCst));
    assert!(closed.load(Ordering::SeqCst));
}

#[tokio::test]
async fn cancellation_drains_before_store_close() {
    let cancellation = CancellationToken::new();
    let sibling = cancellation.clone();
    let stopped = Arc::new(AtomicBool::new(false));
    let observed = stopped.clone();
    let mut tasks = TaskSupervisor::new(cancellation);
    tasks.spawn("http", async move {
        sibling.cancelled().await;
        observed.store(true, Ordering::SeqCst);
        Ok(())
    });
    let result = tasks
        .run(async { Ok(()) }, Duration::from_secs(1), |_| {}, async {
            assert!(stopped.load(Ordering::SeqCst));
            Ok(())
        })
        .await;
    assert!(result.is_ok());
}

#[tokio::test(start_paused = true)]
async fn hung_worker_is_aborted_and_store_close_gets_deadline_budget() {
    let mut tasks = TaskSupervisor::new(CancellationToken::new());
    tasks.spawn("hung", std::future::pending());
    let closed = AtomicBool::new(false);
    let start = tokio::time::Instant::now();
    let result = tasks
        .run(async { Ok(()) }, Duration::from_secs(20), |_| {}, async {
            closed.store(true, Ordering::SeqCst);
            Ok(())
        })
        .await;
    assert!(result.is_err());
    assert!(closed.load(Ordering::SeqCst));
    assert!(start.elapsed() <= Duration::from_secs(20));
}

#[tokio::test]
async fn shutdown_does_not_hide_worker_failure() {
    let cancellation = CancellationToken::new();
    let worker = cancellation.clone();
    let mut tasks = TaskSupervisor::new(cancellation);
    tasks.spawn("writer", async move {
        worker.cancelled().await;
        Err("rollback failed".into())
    });
    let result = tasks
        .run(async { Ok(()) }, Duration::from_secs(1), |_| {}, async {
            Ok(())
        })
        .await;
    assert!(result.is_err());
}

#[tokio::test(start_paused = true)]
async fn slow_store_close_cannot_extend_total_shutdown_budget() {
    let tasks = TaskSupervisor::new(CancellationToken::new());
    let start = tokio::time::Instant::now();
    let result = tasks
        .run(
            async { Ok(()) },
            Duration::from_secs(20),
            |_| {},
            std::future::pending(),
        )
        .await;
    assert!(result.is_err());
    assert_eq!(start.elapsed(), Duration::from_secs(20));
}

#[tokio::test]
async fn worker_panic_reports_its_registered_name() {
    let mut tasks = TaskSupervisor::new(CancellationToken::new());
    tasks.spawn("decoder", async {
        std::panic::resume_unwind(Box::new("worker failed"))
    });
    let mut dead = Vec::new();
    let result = tasks
        .run(
            std::future::pending(),
            Duration::from_secs(1),
            |name| dead.push(name),
            async { Ok(()) },
        )
        .await;
    assert!(result.is_err());
    assert_eq!(dead, ["decoder"]);
}

#[tokio::test]
async fn miner_poll_persists_confirmed_self_hardware_and_does_not_assign_failed_identity()
-> Result<(), Box<dyn std::error::Error>> {
    use quip_dashboard::{
        lifecycle::persist_miner_poll,
        miner::parse::{parse_miner_stats_payload, parse_node_status},
    };
    let directory = tempfile::tempdir()?;
    let store = dashboard_store::Store::open(dashboard_store::StoreConfig::Turso {
        path: directory.path().join("poll.db"),
    })
    .await?;
    store
        .bind_network(&dashboard_model::BlockHash::from([1; 32]), &[])
        .await?;
    let status = parse_node_status(
        &serde_json::json!({"ss58_address":"local-account", "node_id":"local-node", "chain":{"head_number":42}, "miners":[{"id":"cpu-1","type":"CPU"},{"id":"gpu-1","type":"GPU"}]}),
    );
    let stats =
        parse_miner_stats_payload(&serde_json::json!({"controller":{"proofs_submitted":9}}));
    assert_eq!(
        persist_miner_poll(
            &store,
            Some(&status),
            Some(&stats),
            "2026-09-16T00:00:00.000Z"
        )
        .await?,
        Some("local-account".into())
    );
    assert_eq!(
        store.get_self_address().await?.as_deref(),
        Some("local-account")
    );
    let hardware = store
        .get_miner_hardware("local-account")
        .await?
        .ok_or("hardware missing")?;
    assert_eq!(hardware.primary_type, dashboard_model::MinerCategory::Gpu);
    assert_eq!(
        hardware.source,
        dashboard_model::MinerHardwareSource::SelfAccount
    );
    assert_eq!(
        persist_miner_poll(&store, None, None, "2026-09-16T00:00:08.000Z").await?,
        None
    );
    let observability = store
        .get_indexer_observability()
        .await?
        .ok_or("observability missing")?;
    assert_eq!(observability.self_identified, Some(false));
    assert_eq!(
        store.get_miner_hardware("local-account").await?,
        Some(hardware)
    );
    Ok(())
}

#[tokio::test]
async fn submission_walk_is_bounded_and_only_commits_checkpoints_after_rows_or_explicit_gaps()
-> Result<(), Box<dyn std::error::Error>> {
    use quip_dashboard::{
        lifecycle::{mining_catchup_range, persist_mining_attempt},
        miner::parse::{MinerError, MiningSubmissionRecord},
    };
    let directory = tempfile::tempdir()?;
    let store = dashboard_store::Store::open(dashboard_store::StoreConfig::Turso {
        path: directory.path().join("attempts.db"),
    })
    .await?;
    store
        .bind_network(&dashboard_model::BlockHash::from([1; 32]), &[])
        .await?;
    let range = mining_catchup_range(&store, "local-account", 1000).await?;
    assert_eq!(range, (801..=825).collect::<Vec<_>>());
    assert_eq!(
        store.get_mining_checkpoint("local-account").await?,
        Some(800)
    );
    persist_mining_attempt(
        &store,
        "local-account",
        801,
        "2026-09-16T00:00:00.000Z",
        Err(MinerError::NotFound(801)),
    )
    .await?;
    assert_eq!(
        store.get_mining_checkpoint("local-account").await?,
        Some(801)
    );
    assert!(
        persist_mining_attempt(
            &store,
            "local-account",
            802,
            "2026-09-16T00:00:00.000Z",
            Err(MinerError::Unreachable("offline".into()))
        )
        .await
        .is_err()
    );
    assert_eq!(
        store.get_mining_checkpoint("local-account").await?,
        Some(801)
    );
    let record: MiningSubmissionRecord = serde_json::from_value(
        serde_json::json!({"solutionNumber":802,"minerId":"controller-internal-name","minerType":"CPU","tsNs":"1700000000000000000","energyMilli":-50,"diversityMilli":0,"thresholdMilli":0,"lastProofBlockHash":"0x0","extrinsicHash":null,"chainBlockHash":null,"chainBlockNumber":null,"powSequence":null,"outcome":"rejected","attemptCount":1,"bestEnergyMilli":-50,"numValid":0,"qpuAccessTimeUs":0,"observedAt":""}),
    )?;
    persist_mining_attempt(
        &store,
        "local-account",
        802,
        "2026-09-16T00:00:00.000Z",
        Ok(record),
    )
    .await?;
    assert_eq!(
        store.get_mining_checkpoint("local-account").await?,
        Some(802)
    );
    let rows = store
        .get_recent_mining_submissions("local-account", 10)
        .await?;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows.first().ok_or("row missing")?.miner_id, "local-account");
    assert!(
        mining_catchup_range(&store, "local-account", 700)
            .await?
            .is_empty()
    );
    assert_eq!(
        store.get_mining_checkpoint("local-account").await?,
        Some(802)
    );
    Ok(())
}

#[tokio::test]
async fn coverage_projection_preserves_domain_generation_and_initial_floor()
-> Result<(), Box<dyn std::error::Error>> {
    let directory = tempfile::tempdir()?;
    let store = dashboard_store::Store::open(dashboard_store::StoreConfig::Turso {
        path: directory.path().join("coverage.db"),
    })
    .await?;
    store
        .bind_network(&dashboard_model::BlockHash::from([1; 32]), &[])
        .await?;
    let _ = store
        .initialize_coverage(dashboard_store::Indexable::Difficulty, 1, 17.into())
        .await?;
    let _ = store
        .reindex(&[dashboard_store::Indexable::Winners])
        .await?;
    let progress = quip_dashboard::lifecycle::coverage_progress(&store, 3).await?;
    assert_eq!(progress.backfill_queue_depth, 3);
    assert_eq!(progress.coverage.len(), 4);
    assert_eq!(
        progress
            .coverage
            .get("winners")
            .ok_or("winner coverage missing")?
            .generation,
        2
    );
    assert_eq!(progress.difficulty_data_start_block, Some(17.into()));
    assert_eq!(progress.backfill_eta_seconds, Some(None));
    Ok(())
}
