// SPDX-License-Identifier: AGPL-3.0-or-later
//! Counted miner request, failure, cancellation, and payload-budget scenarios.
#![expect(
    clippy::panic_in_result_fn,
    reason = "Test assertions report failures while Result propagates setup and task errors."
)]
use axum::{
    Router,
    extract::{OriginalUri, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
};
use quip_dashboard::miner::{
    MinerService, PeerResolver,
    parse::{ATTEMPT_TRAIL_LIMIT, MinerError, PeerHost},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{net::TcpListener, task::JoinSet};

type TestResult = Result<(), Box<dyn std::error::Error>>;

struct Resolver {
    url: String,
}

struct PeerMap(HashMap<String, PeerHost>);
impl PeerResolver for PeerMap {
    fn resolve<'a>(
        &'a self,
        account: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<PeerHost>, MinerError>> + Send + 'a>> {
        Box::pin(async move { Ok(self.0.get(account).cloned()) })
    }
}
impl PeerResolver for Resolver {
    fn resolve<'a>(
        &'a self,
        _: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<PeerHost>, MinerError>> + Send + 'a>> {
        Box::pin(async {
            Ok(Some(PeerHost {
                public_host: Some(self.url.clone()),
                public_port: None,
            }))
        })
    }
}

#[derive(Default)]
struct Upstream {
    calls: Mutex<HashMap<String, usize>>,
    active: AtomicUsize,
    peak: AtomicUsize,
    delay: AtomicUsize,
    failure: AtomicUsize,
    padding: AtomicUsize,
    status_padding: AtomicUsize,
    dense_items: AtomicUsize,
    trail_len: AtomicUsize,
    last_solution: AtomicUsize,
}
impl Upstream {
    fn count(&self, path: &str) -> usize {
        self.calls
            .lock()
            .map_or(0, |calls| calls.get(path).copied().unwrap_or(0))
    }
}
struct Active(Arc<Upstream>);
impl Drop for Active {
    fn drop(&mut self) {
        let _ = self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

async fn handler(
    State(state): State<Arc<Upstream>>,
    OriginalUri(uri): OriginalUri,
) -> impl IntoResponse {
    if let Ok(mut calls) = state.calls.lock() {
        *calls.entry(uri.path().to_owned()).or_default() += 1;
    }
    let active = state.active.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = state.peak.fetch_max(active, Ordering::SeqCst);
    let _guard = Active(Arc::clone(&state));
    tokio::time::sleep(Duration::from_millis(
        u64::try_from(state.delay.load(Ordering::SeqCst)).unwrap_or(0),
    ))
    .await;
    let failure = state.failure.load(Ordering::SeqCst);
    if failure == 1 {
        return (
            StatusCode::OK,
            json!({"success":false,"error":"failed"}).to_string(),
        );
    }
    if failure > 1 {
        return (
            StatusCode::from_u16(u16::try_from(failure).unwrap_or(500))
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            String::new(),
        );
    }
    let body = match uri.path() {
        "/api/v1/status" => {
            json!({"success":true,"data":{"ss58_address":"alice","node_id":"x".repeat(state.status_padding.load(Ordering::SeqCst)),"miners":[{"id":"GPU A&?","type":"GPU-CUDA"}],"modes":{"GPU":{"controller":{"results_received":9},"miners":[]}}}})
        }
        "/api/v1/stats" => json!({"success":true,"data":{"controller":{"heads_observed":7}}}),
        "/api/v1/mining/attempts" => {
            let query = uri.query().unwrap_or_default();
            let solution = query
                .split('&')
                .find_map(|part| part.strip_prefix("solution_number="))
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(1);
            state
                .last_solution
                .store(usize::try_from(solution).unwrap_or(0), Ordering::SeqCst);
            let trail_len = state.trail_len.load(Ordering::SeqCst);
            if trail_len > 0 {
                // Shaped like a live miner row: one row per iteration, ts_ns ascending.
                let attempts: Vec<Value> = (1..=trail_len)
                    .map(|n| json!({"accepted":false,"best_energy_milli":-14_410_000,"diversity_milli":0,"iter":n,"job_id":"b".repeat(64),"miner_id":"cuda-0","miner_type":"GPU-CUDA","num_valid":0,"qpu_access_time_us":4_344_796,"result_kind":"rejected","solution_number":solution,"submitted":false,"ts_ns":(1_789_786_835_000_000_000_u64 + n as u64).to_string(),"type":"attempt"}))
                    .collect();
                return (
                    StatusCode::OK,
                    json!({"success":true,"data":{"attempts":attempts,"submission":{"solution_number":solution,"miner_id":"cuda-0","energy_milli":-14_448_000,"diversity_milli":0,"threshold_milli":-14_635_662,"last_proof_block_hash":"0x00","outcome":"rejected"}}})
                        .to_string(),
                );
            }
            let padding = "x".repeat(state.padding.load(Ordering::SeqCst));
            let attempts = json!([{"iter":0,"best_energy_milli":-17,"result_kind":"submit","padding":padding,"dense":vec![0; state.dense_items.load(Ordering::SeqCst)]}]);
            json!({"submission":{"solution_number":solution,"miner_id":"alice","energy_milli":-17,"diversity_milli":0,"threshold_milli":2,"last_proof_block_hash":"0x00","outcome":"won"},"attempts":attempts})
        }
        _ => Value::Null,
    };
    (StatusCode::OK, body.to_string())
}

async fn service() -> Result<
    (
        Arc<MinerService>,
        Arc<Upstream>,
        tokio::task::JoinHandle<()>,
    ),
    Box<dyn std::error::Error>,
> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let state = Arc::new(Upstream::default());
    let app = Router::new()
        .fallback(get(handler))
        .with_state(Arc::clone(&state));
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let miner = Arc::new(MinerService::new(
        Some(url.clone()),
        Arc::new(Resolver { url }),
    )?);
    Ok((miner, state, server))
}

#[tokio::test]
async fn hundred_local_consumers_share_eight_second_snapshot() -> TestResult {
    let (service, upstream, server) = service().await?;
    let first = service.local_snapshot().await;
    assert_eq!(first.stats?.data.heads_observed, 7);
    let status = first.status?;
    let mut tasks = JoinSet::new();
    for _ in 0..100 {
        let service = Arc::clone(&service);
        let _ = tasks.spawn(async move { service.local_snapshot().await });
    }
    while let Some(result) = tasks.join_next().await {
        assert!(Arc::ptr_eq(&status, &result?.status?));
    }
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(7)).await;
    let _ = service.local_snapshot().await;
    assert_eq!(upstream.count("/api/v1/status"), 1);
    assert_eq!(upstream.count("/api/v1/stats"), 1);
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::time::resume();
    let next = service.local_snapshot().await;
    assert!(next.status.is_ok());
    assert_eq!(upstream.count("/api/v1/status"), 2);
    server.abort();
    Ok(())
}

#[tokio::test]
async fn hundred_peer_consumers_share_resources_and_five_second_ttl() -> TestResult {
    let (service, upstream, server) = service().await?;
    upstream.delay.store(10, Ordering::SeqCst);
    let mut tasks = JoinSet::new();
    for _ in 0..100 {
        let service = Arc::clone(&service);
        let _ = tasks.spawn(async move { service.peer_snapshot("alice").await });
    }
    while let Some(result) = tasks.join_next().await {
        assert!(result?.status.is_ok());
    }
    assert_eq!(upstream.count("/api/v1/status"), 1);
    assert_eq!(upstream.count("/api/v1/stats"), 1);
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(4)).await;
    assert!(service.peer_snapshot("alice").await.status.is_ok());
    assert_eq!(upstream.count("/api/v1/status"), 1);
    tokio::time::resume();
    server.abort();
    Ok(())
}

#[tokio::test]
async fn failed_peer_envelope_is_negative_cached_for_sixty_seconds() -> TestResult {
    let (service, upstream, server) = service().await?;
    upstream.failure.store(1, Ordering::SeqCst);
    assert!(service.peer_snapshot("alice").await.status.is_err());
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(59)).await;
    for _ in 0..100 {
        assert!(service.peer_snapshot("alice").await.stats.is_err());
    }
    assert_eq!(upstream.count("/api/v1/status"), 1);
    assert_eq!(upstream.count("/api/v1/stats"), 1);
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::time::resume();
    upstream.failure.store(0, Ordering::SeqCst);
    assert!(service.peer_snapshot("alice").await.status.is_ok());
    assert_eq!(upstream.count("/api/v1/status"), 2);
    server.abort();
    Ok(())
}

#[tokio::test]
async fn different_peer_resources_never_exceed_two_requests() -> TestResult {
    let upstream = Arc::new(Upstream::default());
    let mut hosts = HashMap::new();
    let mut servers = Vec::new();
    for peer in 1..=20 {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let _ = hosts.insert(
            format!("peer-{peer}"),
            PeerHost {
                public_host: Some(format!("http://{}", listener.local_addr()?)),
                public_port: None,
            },
        );
        let app = Router::new()
            .fallback(get(handler))
            .with_state(Arc::clone(&upstream));
        servers.push(tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        }));
    }
    let service = Arc::new(MinerService::new(None, Arc::new(PeerMap(hosts)))?);
    upstream.delay.store(30, Ordering::SeqCst);
    let mut tasks = JoinSet::new();
    for solution in 2..=21 {
        let service = Arc::clone(&service);
        let _ = tasks.spawn(async move {
            service
                .peer_attempts(&format!("peer-{}", solution - 1), solution)
                .await
        });
    }
    while let Some(result) = tasks.join_next().await {
        assert!(result??.data.submission.solution_number > 0);
    }
    assert_eq!(upstream.peak.load(Ordering::SeqCst), 2);
    for server in servers {
        server.abort();
    }
    Ok(())
}

#[tokio::test]
async fn cancellation_releases_request_and_singleflight_permits() -> TestResult {
    let (service, upstream, server) = service().await?;
    upstream.delay.store(1000, Ordering::SeqCst);
    let one = Arc::clone(&service);
    let task = tokio::spawn(async move { one.peer_snapshot("alice").await });
    while upstream.active.load(Ordering::SeqCst) < 2 {
        tokio::task::yield_now().await;
    }
    task.abort();
    assert!(task.await.is_err());
    upstream.delay.store(0, Ordering::SeqCst);
    let snapshot =
        tokio::time::timeout(Duration::from_millis(500), service.peer_snapshot("alice")).await?;
    assert!(snapshot.status.is_ok());
    assert!(snapshot.stats.is_ok());
    server.abort();
    Ok(())
}

#[tokio::test]
async fn borrowed_evicted_payloads_still_count_against_six_mib() -> TestResult {
    let (service, upstream, server) = service().await?;
    upstream.padding.store(220_000, Ordering::SeqCst);
    let mut held = Vec::new();
    let mut rejected = false;
    for solution in 2..=46 {
        match service.local_attempts(solution).await {
            Ok(value) => held.push(value),
            Err(MinerError::BodyTooLarge { .. }) => rejected = true,
            Err(error) => return Err(error.into()),
        }
        assert!(service.retained_bytes() <= 6 * 1024 * 1024);
    }
    assert!(rejected);
    assert!(service.retained_bytes() > 5 * 1024 * 1024);
    let before = service.retained_bytes();
    drop(held);
    assert!(service.retained_bytes() < before);
    assert!(service.local_attempts(100).await.is_ok());
    server.abort();
    Ok(())
}

#[tokio::test]
async fn oversized_responses_and_attempt_error_statuses_are_preserved() -> TestResult {
    let (service, upstream, server) = service().await?;
    upstream.padding.store(5 * 1024 * 1024, Ordering::SeqCst);
    assert!(matches!(
        service.local_attempts(5).await,
        Err(MinerError::BodyTooLarge { .. })
    ));
    upstream.failure.store(404, Ordering::SeqCst);
    assert!(matches!(
        service.local_attempts(2).await,
        Err(MinerError::NotFound(2))
    ));
    // Chain qblock 1 predates any accepted qblock: the miner has no number
    // for it, so the service answers without a request.
    let calls = upstream.count("/api/v1/mining/attempts");
    assert!(matches!(
        service.local_attempts(1).await,
        Err(MinerError::NotFound(1))
    ));
    assert_eq!(upstream.count("/api/v1/mining/attempts"), calls);
    upstream.failure.store(429, Ordering::SeqCst);
    assert!(matches!(
        service.local_attempts(3).await,
        Err(MinerError::RateLimited)
    ));
    assert!(matches!(
        service.local_attempts(0).await,
        Err(MinerError::InvalidSolutionNumber)
    ));
    server.abort();
    Ok(())
}

#[tokio::test]
async fn adjacent_dispatches_share_each_attempt_resource() -> TestResult {
    let (service, upstream, server) = service().await?;
    let first = service.local_dispatch(42).await?;
    assert_eq!(
        first.data.as_ref().map(|dispatch| dispatch.solution_number),
        Some(42)
    );
    let mut tasks = JoinSet::new();
    for _ in 0..100 {
        let service = Arc::clone(&service);
        let _ = tasks.spawn(async move { service.local_dispatch(43).await });
    }
    while let Some(result) = tasks.join_next().await {
        assert_eq!(
            result??
                .data
                .as_ref()
                .map(|dispatch| dispatch.solution_number),
            Some(43)
        );
    }
    assert_eq!(upstream.count("/api/v1/status"), 1);
    assert_eq!(upstream.count("/api/v1/mining/attempts"), 3);
    server.abort();
    Ok(())
}

#[tokio::test]
async fn long_dispatch_trail_keeps_newest_attempts() -> TestResult {
    let (service, upstream, server) = service().await?;
    upstream.trail_len.store(6_000, Ordering::SeqCst);
    let dispatch = service.local_dispatch(42).await?;
    let attempts = &dispatch
        .data
        .as_ref()
        .ok_or("dispatch trail dropped")?
        .attempts;
    assert_eq!(attempts.len(), ATTEMPT_TRAIL_LIMIT);
    let newest = attempts.iter().map(|attempt| attempt.iter).max();
    assert_eq!(newest, Some(6_000));
    server.abort();
    Ok(())
}

#[tokio::test]
async fn long_submission_trail_keeps_newest_attempts_and_full_count() -> TestResult {
    let (service, upstream, server) = service().await?;
    upstream.trail_len.store(6_000, Ordering::SeqCst);
    let response = service.local_attempts(42).await?;
    // Chain qblock 42 is miner solution 41; the response reports chain ids.
    assert_eq!(upstream.last_solution.load(Ordering::SeqCst), 41);
    assert_eq!(response.data.submission.solution_number, 42);
    assert!(
        response
            .data
            .attempts
            .iter()
            .all(|attempt| attempt.extra.get("solution_number") == Some(&json!(42)))
    );
    assert_eq!(response.data.submission.attempt_count, 6_000);
    assert_eq!(response.data.attempts.len(), ATTEMPT_TRAIL_LIMIT);
    let newest = response
        .data
        .attempts
        .iter()
        .map(|attempt| attempt.iter)
        .max();
    assert_eq!(newest, Some(6_000));
    server.abort();
    Ok(())
}

#[tokio::test]
async fn trail_past_the_whole_body_cap_streams() -> TestResult {
    let (service, upstream, server) = service().await?;
    // About 5.7 MB on the wire, over the 4 MB cap that a whole-body read uses.
    upstream.trail_len.store(16_000, Ordering::SeqCst);
    let response = service.local_attempts(42).await?;
    assert_eq!(response.data.submission.attempt_count, 16_000);
    assert_eq!(response.data.attempts.len(), ATTEMPT_TRAIL_LIMIT);
    let dispatch = service.local_dispatch(43).await?;
    assert_eq!(
        dispatch
            .data
            .as_ref()
            .map(|dispatch| dispatch.attempts.len()),
        Some(ATTEMPT_TRAIL_LIMIT)
    );
    server.abort();
    Ok(())
}

#[tokio::test]
async fn transport_failure_blocks_new_resources_for_same_host() -> TestResult {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    drop(listener);
    let service = MinerService::new(
        None,
        Arc::new(Resolver {
            url: format!("http://{address}"),
        }),
    )?;
    assert!(service.peer_snapshot("alice").await.status.is_err());
    let listener = TcpListener::bind(address).await?;
    let upstream = Arc::new(Upstream::default());
    let app = Router::new()
        .fallback(get(handler))
        .with_state(Arc::clone(&upstream));
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(59)).await;
    assert!(service.peer_attempts("alice", 100).await.is_err());
    assert_eq!(upstream.count("/api/v1/mining/attempts"), 0);
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::time::resume();
    assert!(service.peer_attempts("alice", 101).await.is_ok());
    assert_eq!(upstream.count("/api/v1/mining/attempts"), 1);
    server.abort();
    Ok(())
}

#[tokio::test]
async fn mutable_attempts_refresh_and_large_valid_attempts_fit() -> TestResult {
    let (service, upstream, server) = service().await?;
    upstream.padding.store(300_000, Ordering::SeqCst);
    let first = service.local_attempts(2).await?;
    assert!(first.data.submission.observed_at.ends_with('Z'));
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(9)).await;
    tokio::time::resume();
    let second = service.local_attempts(2).await?;
    assert!(!Arc::ptr_eq(&first, &second));
    assert_eq!(upstream.count("/api/v1/mining/attempts"), 2);
    server.abort();
    Ok(())
}

#[tokio::test]
async fn stalled_stream_obeys_total_body_deadline() -> TestResult {
    use tokio::io::AsyncWriteExt;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        if let Ok((mut socket, _)) = listener.accept().await {
            let _ = socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n{")
                .await;
            tokio::time::sleep(Duration::from_secs(8)).await;
        }
    });
    let service = MinerService::new(Some(url.clone()), Arc::new(Resolver { url }))?;
    let started = std::time::Instant::now();
    assert!(matches!(
        service.local_attempts(2).await,
        Err(MinerError::Unreachable(_))
    ));
    assert!(started.elapsed() < Duration::from_secs(5));
    server.abort();
    Ok(())
}

#[tokio::test]
async fn expired_attempt_cache_cannot_starve_local_status() -> TestResult {
    let (service, upstream, server) = service().await?;
    assert!(service.local_snapshot().await.status.is_ok());
    upstream.padding.store(2_000_000, Ordering::SeqCst);
    for solution in 2..=4 {
        drop(service.local_attempts(solution).await?);
    }
    assert!(service.retained_bytes() > 5_900_000);
    upstream.status_padding.store(500_000, Ordering::SeqCst);
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(9)).await;
    tokio::time::resume();
    let snapshot = service.local_snapshot().await;
    assert_eq!(snapshot.status?.data.node_id.len(), 500_000);
    assert_eq!(snapshot.stats?.data.heads_observed, 7);
    assert!(service.retained_bytes() < 1_000_000);
    assert_eq!(upstream.count("/api/v1/mining/attempts"), 3);
    server.abort();
    Ok(())
}

#[tokio::test]
async fn dense_valid_wire_payload_can_exceed_retained_budget() -> TestResult {
    let (service, upstream, server) = service().await?;
    upstream.dense_items.store(300_000, Ordering::SeqCst);
    // The response is about 600 KiB on the wire, but its parsed JSON nodes
    // require more than the six MiB reservation limit.
    assert_eq!(
        service.local_attempts(2).await.err(),
        Some(MinerError::BodyTooLarge {
            cap: 6 * 1024 * 1024
        })
    );
    assert_eq!(service.retained_bytes(), 0);
    server.abort();
    Ok(())
}

#[tokio::test]
async fn cross_cache_pruning_preserves_borrowed_observation_charges() -> TestResult {
    let (service, upstream, server) = service().await?;
    upstream.padding.store(2_000_000, Ordering::SeqCst);
    let mut held = Vec::new();
    for solution in 2..=4 {
        held.push(service.local_attempts(solution).await?);
    }
    upstream.status_padding.store(500_000, Ordering::SeqCst);
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(9)).await;
    tokio::time::resume();
    assert_eq!(
        service.local_snapshot().await.status.err(),
        Some(MinerError::BodyTooLarge {
            cap: 6 * 1024 * 1024
        })
    );
    assert!(service.retained_bytes() > 5_900_000);
    drop(held);
    assert!(service.retained_bytes() < 1_000_000);
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(9)).await;
    tokio::time::resume();
    assert_eq!(
        service.local_snapshot().await.status?.data.node_id.len(),
        500_000
    );
    assert_eq!(upstream.count("/api/v1/mining/attempts"), 3);
    server.abort();
    Ok(())
}
