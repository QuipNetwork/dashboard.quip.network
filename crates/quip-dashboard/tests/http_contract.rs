// SPDX-License-Identifier: AGPL-3.0-or-later
//! Replay the captured TypeScript API against real Turso and loopback miner HTTP.
#![expect(
    clippy::panic_in_result_fn,
    reason = "Contract tests use assertions while propagating fixture and IO errors"
)]
#![expect(
    clippy::indexing_slicing,
    reason = "Serde JSON fixture indexing returns null for absent object keys; typed decoding reports malformed fixtures"
)]

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Query, State},
    http::{Request, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use dashboard_model::{
    BabeEpochState, BlockHash, BlockRecord, NodeDescriptorRecord, QBlockParticipationRecord,
};
use dashboard_store::{
    AuthorshipRecord, BlockCommit, BlockRecords, GenerationGuard, Indexable, Store, StoreConfig,
};
use quip_dashboard::{
    health::{HealthState, Phase},
    http::{HttpState, router},
    miner::{
        MinerService, PeerResolver,
        parse::{MinerError, PeerHost},
    },
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{collections::HashMap, error::Error, future::Future, path::PathBuf, pin::Pin, sync::Arc};
use tower::ServiceExt;
type TestResult<T = ()> = Result<T, Box<dyn Error + Send + Sync>>;
fn fixture(name: &str) -> TestResult<Value> {
    Ok(serde_json::from_slice(&std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )?)?)
}
fn decode<T: DeserializeOwned>(value: &Value) -> TestResult<T> {
    Ok(serde_json::from_value(value.clone())?)
}
fn array<'a>(value: &'a Value, key: &str) -> TestResult<&'a Vec<Value>> {
    value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("missing fixture {key}").into())
}
#[expect(
    clippy::too_many_lines,
    reason = "Seed replay enumerates the captured independent store surfaces once"
)]
async fn seed(store: &Store, seed: &Value) -> TestResult {
    let genesis = format!("0x{}", "00".repeat(32)).parse::<BlockHash>()?;
    store.bind_network(&genesis, &[]).await?;
    for domain in [
        Indexable::Winners,
        Indexable::Difficulty,
        Indexable::Participation,
        Indexable::Authorship,
    ] {
        let _ = store.initialize_coverage(domain, 1, "1".parse()?).await?;
    }
    if seed.as_object().is_none_or(serde_json::Map::is_empty) {
        return Ok(());
    }
    store
        .set_self_address(seed.get("selfAddress").and_then(Value::as_str))
        .await?;
    for row in array(seed, "blocks")? {
        let winner: BlockRecord = decode(row)?;
        let participants: Vec<QBlockParticipationRecord> = array(seed, "participation")?
            .iter()
            .filter(|row| row.get("blockNumber") == Some(&json!(winner.substrate_block_number)))
            .map(decode)
            .collect::<TestResult<_>>()?;
        let domains = [Indexable::Winners, Indexable::Participation];
        let _ = store
            .commit_block(&BlockCommit {
                genesis: genesis.clone(),
                hash: winner.substrate_block_hash.clone(),
                height: winner.substrate_block_number.clone(),
                guards: domains
                    .into_iter()
                    .map(|indexable| GenerationGuard {
                        indexable,
                        expected: 1,
                    })
                    .collect(),
                records: BlockRecords {
                    winner: Some(winner),
                    participation: participants,
                    ..BlockRecords::default()
                },
                completed: domains.to_vec(),
            })
            .await?;
    }
    for (index, row) in array(seed, "difficulty")?.iter().enumerate() {
        let difficulty: dashboard_model::DifficultyRecord = decode(row)?;
        if difficulty.source == dashboard_model::DifficultySource::Poll {
            store.insert_difficulty_snapshot(&difficulty).await?;
        } else {
            let _ = store
                .commit_block(&BlockCommit {
                    genesis: genesis.clone(),
                    hash: format!("0x{}", format!("{:02x}", index + 32).repeat(32)).parse()?,
                    height: difficulty.observed_at_block.clone(),
                    guards: vec![GenerationGuard {
                        indexable: Indexable::Difficulty,
                        expected: 1,
                    }],
                    records: BlockRecords {
                        difficulty: Some(difficulty),
                        ..BlockRecords::default()
                    },
                    completed: vec![Indexable::Difficulty],
                })
                .await?;
        }
    }
    store
        .upsert_chain_miners(&decode::<Vec<_>>(&seed["chainMiners"])?)
        .await?;
    let epoch: BabeEpochState = decode(&seed["babeEpoch"])?;
    store.upsert_babe_epoch(&epoch).await?;
    store
        .upsert_babe_authorities(
            epoch.epoch_index,
            &decode::<Vec<_>>(&seed["babeAuthorities"])?,
        )
        .await?;
    for (index, row) in array(seed, "authorship")?.iter().enumerate() {
        let author = AuthorshipRecord {
            account_id: decode(&row["accountId"])?,
            block_number: decode(&row["blockNumber"])?,
            timestamp: decode(&row["blockTimestamp"])?,
            had_winner: decode(&row["hasPow"])?,
        };
        let _ = store
            .commit_block(&BlockCommit {
                genesis: genesis.clone(),
                hash: format!("0x{}", format!("{:02x}", index + 1).repeat(32)).parse()?,
                height: author.block_number.clone(),
                guards: vec![GenerationGuard {
                    indexable: Indexable::Authorship,
                    expected: 1,
                }],
                records: BlockRecords {
                    authorship: Some(author),
                    ..BlockRecords::default()
                },
                completed: vec![Indexable::Authorship],
            })
            .await?;
    }
    store
        .upsert_chain_head(&decode(&seed["chainHead"])?)
        .await?;
    store
        .set_indexer_observability(&decode(&seed["indexer"])?)
        .await?;
    for row in array(seed, "minerHardware")? {
        store.upsert_miner_hardware(&decode(row)?).await?;
    }
    store
        .set_mineable_topologies(&decode::<Vec<_>>(&seed["mineableTopologies"])?)
        .await?;
    for row in array(seed, "nodeDescriptors")? {
        let descriptor: NodeDescriptorRecord = decode(row)?;
        store.upsert_node_descriptor(&descriptor).await?;
        store
            .backfill_node_descriptor_first_seen(
                &descriptor.account_id,
                descriptor.first_block_timestamp,
            )
            .await?;
    }
    for row in array(seed, "miningSubmissions")? {
        store.insert_mining_submission(&decode(row)?).await?;
    }
    Ok(())
}
#[derive(Clone)]
struct Upstream {
    data: Value,
    host: &'static str,
}
async fn upstream(
    State(state): State<Upstream>,
    uri: Uri,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if state.host == "test-validator:9944" && uri.path() == "/api/v1/status" {
        return Json(json!({"miners":[{"id":"quip-miner-pow-CPU-1","type":"CPU"}]}))
            .into_response();
    }
    if let Some(rows) = state.data.as_array() {
        for row in rows {
            if row.get("host").and_then(Value::as_str) != Some(state.host)
                || row.get("path").and_then(Value::as_str) != Some(uri.path())
            {
                continue;
            }
            let matches = row
                .get("query")
                .and_then(Value::as_object)
                .is_none_or(|expected| {
                    expected
                        .iter()
                        .all(|(key, value)| query.get(key).map(String::as_str) == value.as_str())
                });
            if matches {
                let status = row
                    .get("status")
                    .and_then(Value::as_u64)
                    .and_then(|value| u16::try_from(value).ok())
                    .and_then(|value| StatusCode::from_u16(value).ok())
                    .unwrap_or(StatusCode::BAD_GATEWAY);
                return (
                    status,
                    Json(row.get("body").cloned().unwrap_or(Value::Null)),
                )
                    .into_response();
            }
        }
    }
    StatusCode::NOT_FOUND.into_response()
}
async fn server(
    data: &Value,
    host: &'static str,
) -> TestResult<(std::net::SocketAddr, tokio::task::JoinHandle<()>)> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let router = Router::new().fallback(upstream).with_state(Upstream {
        data: data.clone(),
        host,
    });
    let task = tokio::spawn(async move {
        let _result = axum::serve(listener, router).await;
    });
    Ok((address, task))
}
struct Peers {
    store: Arc<Store>,
    peer: std::net::SocketAddr,
}
impl PeerResolver for Peers {
    fn resolve<'a>(
        &'a self,
        account: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<PeerHost>, MinerError>> + Send + 'a>> {
        Box::pin(async move {
            let row = self
                .store
                .get_node_descriptor(account)
                .await
                .map_err(|error| MinerError::Http(error.to_string()))?;
            Ok(row.and_then(|row| {
                row.descriptor.public_host.map(|host| PeerHost {
                    public_host: Some("127.0.0.1".into()),
                    public_port: Some(if host == "1.2.3.4" {
                        self.peer.port()
                    } else {
                        1
                    }),
                })
            }))
        })
    }
}
fn state(
    store: Arc<Store>,
    miner: Arc<MinerService>,
    now: chrono::DateTime<chrono::Utc>,
) -> HttpState {
    let health = HealthState::new(false);
    health.set_phase(Phase::Ready);
    HttpState::new(store, miner, health).with_clock(Arc::new(move || now))
}
#[tokio::test]
async fn captured_data_routes_match_real_store_and_miner() -> TestResult {
    let data = fixture("seed.json")?;
    let manifest = fixture("manifest.json")?;
    let now =
        chrono::DateTime::parse_from_rfc3339(data["nowIso"].as_str().ok_or("fixture clock")?)?
            .with_timezone(&chrono::Utc);
    let (local, local_task) = server(&data["upstream"], "test-validator:9944").await?;
    let (peer, peer_task) = server(&data["upstream"], "1.2.3.4:8088").await?;
    for case in manifest.as_array().ok_or("manifest array")? {
        let name = case["name"].as_str().ok_or("case name")?;
        // Health uses actual process state, so the old unconditional ok:true
        // snapshots are intentionally superseded by the dedicated health tests.
        if name.starts_with("health-") {
            continue;
        }
        let directory = tempfile::tempdir()?;
        let store = Arc::new(
            Store::open(StoreConfig::Turso {
                path: directory.path().join("fixture.db"),
            })
            .await?,
        );
        seed(
            &store,
            &data["seeds"][case["seed"].as_str().ok_or("seed name")?],
        )
        .await?;
        let base = if name == "mining-attempts-unresolvable" {
            None
        } else if name == "mining-attempts-upstream-down" {
            Some("http://127.0.0.1:1".into())
        } else {
            Some(format!("http://{local}"))
        };
        let miner = Arc::new(MinerService::new(
            base,
            Arc::new(Peers {
                store: Arc::clone(&store),
                peer,
            }),
        )?);
        let app = router(state(Arc::clone(&store), miner, now));
        let response = app
            .oneshot(
                Request::builder()
                    .uri(case["path"].as_str().ok_or("path")?)
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(
            u64::from(response.status().as_u16()),
            case["status"].as_u64().ok_or("status")?,
            "{name}"
        );
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-origin")
                .ok_or("CORS")?,
            "*",
            "{name}"
        );
        let actual: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4 * 1024 * 1024).await?)?;
        let expected = fixture(case["bodyFile"].as_str().ok_or("body file")?)?;
        if name == "mining-attempts-upstream-down" {
            // The capture injected the literal ECONNREFUSED. The real client
            // retains its transport detail, which varies with the OS and URL.
            assert_eq!(actual["error"], expected["error"], "{name}");
            assert!(
                actual["detail"]
                    .as_str()
                    .is_some_and(|detail| !detail.is_empty())
            );
        } else {
            assert!(
                json_equal(&actual, &expected),
                "{name}: actual {actual}, expected {expected}"
            );
        }
        Arc::try_unwrap(store)
            .map_err(|_| "fixture still holds store")?
            .close()
            .await?;
    }
    local_task.abort();
    peer_task.abort();
    let _ = local_task.await;
    let _ = peer_task.await;
    Ok(())
}
#[tokio::test]
async fn readiness_liveness_cors_and_response_admission() -> TestResult {
    let directory = tempfile::tempdir()?;
    let store = Arc::new(
        Store::open(StoreConfig::Turso {
            path: directory.path().join("health.db"),
        })
        .await?,
    );
    let miner = Arc::new(MinerService::new(
        None,
        Arc::new(Peers {
            store: Arc::clone(&store),
            peer: "127.0.0.1:1".parse()?,
        }),
    )?);
    let health = HealthState::new(true);
    let app = router(HttpState::new(Arc::clone(&store), miner, health.clone()));
    let ready = app
        .clone()
        .oneshot(Request::builder().uri("/api/health").body(Body::empty())?)
        .await?;
    assert_eq!(ready.status(), StatusCode::SERVICE_UNAVAILABLE);
    drop(ready);
    let live = app
        .clone()
        .oneshot(Request::builder().uri("/api/live").body(Body::empty())?)
        .await?;
    assert_eq!(live.status(), StatusCode::OK);
    drop(live);
    for path in [
        "/api/mining-history?since=2026-07-01",
        "/api/difficulty-history?since=2026-07-01",
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty())?)
            .await?;
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_slice(&to_bytes(response.into_body(), 1024).await?)?;
        assert_eq!(body.get("since"), Some(&json!("2026-07-01")));
    }
    let mut held = Vec::new();
    for _ in 0..8 {
        held.push(
            app.clone()
                .oneshot(Request::builder().uri("/api/blocks").body(Body::empty())?)
                .await?,
        );
    }
    let busy = app
        .clone()
        .oneshot(Request::builder().uri("/api/blocks").body(Body::empty())?)
        .await?;
    assert_eq!(busy.status(), StatusCode::SERVICE_UNAVAILABLE);
    drop(busy);
    let still_live = app
        .clone()
        .oneshot(Request::builder().uri("/api/live").body(Body::empty())?)
        .await?;
    assert_eq!(still_live.status(), StatusCode::OK);
    drop(still_live);
    drop(held);
    let options = app
        .clone()
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/api/telemetry")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(options.status(), StatusCode::NO_CONTENT);
    drop(options);
    health.task_exited(quip_dashboard::health::RequiredTask::Indexer);
    let failed = app
        .clone()
        .oneshot(Request::builder().uri("/api/live").body(Body::empty())?)
        .await?;
    assert_eq!(failed.status(), StatusCode::SERVICE_UNAVAILABLE);
    drop(failed);
    drop(app);
    Arc::try_unwrap(store)
        .map_err(|_| "health still holds store")?
        .close()
        .await?;
    Ok(())
}

fn json_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| json_equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| json_equal(a, b)))
        }
        _ => a == b,
    }
}

#[tokio::test]
async fn telemetry_cache_is_single_flight_and_charges_held_bodies() -> TestResult {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let directory = tempfile::tempdir()?;
    let store = Arc::new(
        Store::open(StoreConfig::Turso {
            path: directory.path().join("cache.db"),
        })
        .await?,
    );
    let miner = Arc::new(MinerService::new(
        None,
        Arc::new(Peers {
            store: Arc::clone(&store),
            peer: "127.0.0.1:1".parse()?,
        }),
    )?);
    let clock_reads = Arc::new(AtomicUsize::new(0));
    let clock_counter = Arc::clone(&clock_reads);
    let now = chrono::Utc::now();
    // The operator account also seeds `files.minerCurrentDispatch`, which
    // embeds the same account a second time, so a single build now spends
    // roughly double the account length. 1000 KiB keeps one build well
    // under budget while two of them still exceed it.
    let state = HttpState::new(Arc::clone(&store), miner, HealthState::new(false))
        .with_operator_account(Some("A".repeat(1000 * 1024)))
        .with_clock(Arc::new(move || {
            let _ = clock_counter.fetch_add(1, Ordering::SeqCst);
            now
        }));
    let app = router(state.clone());
    let (first, second) = tokio::try_join!(
        app.clone().oneshot(
            Request::builder()
                .uri("/api/telemetry")
                .body(Body::empty())?
        ),
        app.clone().oneshot(
            Request::builder()
                .uri("/api/telemetry")
                .body(Body::empty())?
        )
    )?;
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(second.status(), StatusCode::OK);
    assert_eq!(
        clock_reads.load(Ordering::SeqCst),
        2,
        "One build supplies validator clock and server timestamp"
    );
    drop(second);
    tokio::time::sleep(std::time::Duration::from_millis(1010)).await;
    let exhausted = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/telemetry")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(
        exhausted.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "Expired bytes held by a response retain their quota"
    );
    drop(exhausted);
    drop(first);
    let recovered = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/telemetry")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(recovered.status(), StatusCode::OK);
    drop(recovered);
    drop(app);
    let oversized = router(state.with_operator_account(Some("A".repeat(2 * 1024 * 1024))));
    tokio::time::sleep(std::time::Duration::from_millis(1010)).await;
    let response = oversized
        .oneshot(
            Request::builder()
                .uri("/api/telemetry")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    drop(response);
    Arc::try_unwrap(store)
        .map_err(|_| "cache still holds store")?
        .close()
        .await?;
    Ok(())
}

fn budget_app(store: &Arc<Store>) -> TestResult<Router> {
    let miner = Arc::new(MinerService::new(
        None,
        Arc::new(Peers {
            store: Arc::clone(store),
            peer: "127.0.0.1:1".parse()?,
        }),
    )?);
    Ok(router(HttpState::new(
        Arc::clone(store),
        miner,
        HealthState::new(false),
    )))
}
async fn request(app: &Router, path: &str) -> TestResult<Response> {
    Ok(app
        .clone()
        .oneshot(Request::builder().uri(path).body(Body::empty())?)
        .await?)
}
#[tokio::test]
async fn uncached_bodies_hold_byte_quota_and_oversize_returns_error() -> TestResult {
    let directory = tempfile::tempdir()?;
    let store = Arc::new(
        Store::open(StoreConfig::Turso {
            path: directory.path().join("history.db"),
        })
        .await?,
    );
    let genesis: BlockHash = format!("0x{:064x}", 0).parse()?;
    store.bind_network(&genesis, &[]).await?;
    let data = fixture("seed.json")?;
    let mut winner: BlockRecord = decode(&data["seeds"]["populated"]["blocks"][0])?;
    winner.miner_id = "A".repeat(1100 * 1024);
    let mut batch = BlockCommit {
        genesis,
        hash: winner.substrate_block_hash.clone(),
        height: winner.substrate_block_number.clone(),
        guards: vec![GenerationGuard {
            indexable: Indexable::Winners,
            expected: 1,
        }],
        records: BlockRecords {
            winner: Some(winner),
            ..BlockRecords::default()
        },
        completed: vec![Indexable::Winners],
    };
    let _ = store.commit_block(&batch).await?;
    let app = budget_app(&store)?;
    let first = request(&app, "/api/blocks").await?;
    assert_eq!(first.status(), StatusCode::OK);
    let full = request(&app, "/api/blocks").await?;
    assert_eq!(full.status(), StatusCode::SERVICE_UNAVAILABLE);
    let error: Value = serde_json::from_slice(&to_bytes(full.into_body(), 1024).await?)?;
    assert_eq!(error, json!({"error":"response capacity exceeded"}));
    drop(first);
    assert_eq!(request(&app, "/api/blocks").await?.status(), StatusCode::OK);
    let winner = batch.records.winner.as_mut().ok_or("winner")?;
    winner.miner_id = "A".repeat(2 * 1024 * 1024);
    let _ = store.commit_block(&batch).await?;
    assert_eq!(
        request(&app, "/api/blocks").await?.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    store
        .set_self_address(Some(&"x".repeat(8 * 1024 * 1024 + 1)))
        .await?;
    assert_eq!(
        request(&app, "/api/telemetry").await?.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    drop(app);
    Arc::try_unwrap(store)
        .map_err(|_| "store still held")?
        .close()
        .await?;
    Ok(())
}

#[tokio::test]
async fn telemetry_preserves_more_than_4096_participation_facts() -> TestResult {
    let directory = tempfile::tempdir()?;
    let store = Arc::new(
        Store::open(StoreConfig::Turso {
            path: directory.path().join("participation.db"),
        })
        .await?,
    );
    let genesis: BlockHash = format!("0x{:064x}", 0).parse()?;
    store.bind_network(&genesis, &[]).await?;
    let data = fixture("seed.json")?;
    let template: BlockRecord = decode(&data["seeds"]["populated"]["blocks"][0])?;
    let now = u64::try_from(chrono::Utc::now().timestamp())?;
    for height in 1_u64..=2101 {
        let mut winner = template.clone();
        winner.qblock_id = height.into();
        winner.substrate_block_number = height.into();
        winner.substrate_block_hash = format!("0x{height:064x}").parse()?;
        winner.block_hash = winner.substrate_block_hash.clone();
        winner.timestamp = now - 2102 + height;
        let participants = ["alice", "bob"]
            .into_iter()
            .map(|account| QBlockParticipationRecord {
                qblock_id: height.into(),
                account: account.into(),
                kind: "CPU".into(),
                budget_seconds: Some(1.0),
                block_number: height.into(),
            })
            .collect();
        let domains = [Indexable::Winners, Indexable::Participation];
        let _ = store
            .commit_block(&BlockCommit {
                genesis: genesis.clone(),
                hash: winner.substrate_block_hash.clone(),
                height: height.into(),
                guards: domains
                    .into_iter()
                    .map(|indexable| GenerationGuard {
                        indexable,
                        expected: 1,
                    })
                    .collect(),
                records: BlockRecords {
                    winner: Some(winner),
                    participation: participants,
                    ..BlockRecords::default()
                },
                completed: domains.to_vec(),
            })
            .await?;
    }
    let app = budget_app(&store)?;
    let response = request(&app, "/api/telemetry").await?;
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024).await?;
    let body: Value = serde_json::from_slice(&bytes)?;
    // Participation facts are now file-backed: the slimmed telemetry response
    // carries a files pointer instead of the 4,200 participation rows, so the
    // payload stays far under the 2 MiB capacity cap even with a full store.
    assert_eq!(
        body["files"]["qblocksManifest"],
        "/files/qblocks/metadata.json"
    );
    assert!(
        body.get("currentDispatch").is_none(),
        "currentDispatch must not be inlined in telemetry"
    );
    // This store has no self address, so the pointer is absent rather than a URL.
    assert!(body["files"]["minerCurrentDispatch"].is_null());
    assert_eq!(body["files"]["nodesSnapshot"], "/files/nodes/snapshot.json");
    // Production measured 1,479,476 bytes before blocks, nodes,
    // nodeDescriptors and currentDispatch moved to files. The budget is
    // deliberately tight: the HTTP admission window holds a permit for the
    // whole body transfer, so payload size sets how many readers fit.
    assert!(
        bytes.len() < 128 * 1024,
        "telemetry grew to {} bytes; the large fields belong in files",
        bytes.len()
    );
    assert!(
        body.get("blocks").is_none(),
        "blocks must come from the qblock files, not telemetry"
    );
    // The paging route stays the supported way to read blocks directly.
    let paged = request(&app, "/api/blocks?limit=1").await?;
    assert_eq!(paged.status(), StatusCode::OK);
    let paged_bytes = to_bytes(paged.into_body(), 2 * 1024 * 1024).await?;
    let paged_body: Value = serde_json::from_slice(&paged_bytes)?;
    assert_eq!(
        paged_body["blocks"].as_array().map(Vec::len),
        Some(1),
        "the paging route still returns blocks"
    );
    drop(app);
    Arc::try_unwrap(store)
        .map_err(|_| "store still held")?
        .close()
        .await?;
    Ok(())
}
