//! Chain byte fixtures and bounded transport regression tests.
/// Jsonrpsee.
use jsonrpsee::{
    RpcModule,
    server::{ServerBuilder, ServerHandle},
    types::ErrorObjectOwned,
};
use parity_scale_codec::{Compact, Decode, Encode};
use quip_dashboard::chain::{
    BlockHash, BlockPurpose, ChainError, ChainReader, ParticipantCursor, WinnerCursor, WorkClass,
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

type TestResult = Result<(), Box<dyn std::error::Error>>;
#[derive(Default)]
struct Fake {
    calls: Mutex<Vec<(String, Value, usize)>>,
    active: AtomicUsize,
    max: AtomicUsize,
    backfill: AtomicUsize,
    max_backfill: AtomicUsize,
    pressure: AtomicUsize,
    winner_failures: AtomicUsize,
}
struct Running {
    fake: Arc<Fake>,
    backfill: bool,
}
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.fake.active.fetch_sub(1, Ordering::SeqCst);
        if self.backfill {
            let _ = self.fake.backfill.fetch_sub(1, Ordering::SeqCst);
        }
    }
}
fn hash(n: u8) -> BlockHash {
    BlockHash([n; 32])
}
fn hex(bytes: impl AsRef<[u8]>) -> Value {
    json!(format!("0x{}", hex::encode(bytes)))
}
fn key(pallet: &str, entry: &str) -> String {
    format!(
        "0x{}",
        hex::encode(subxt_core::storage::get_address_root_bytes(
            &subxt_core::dynamic::storage(pallet, entry, Vec::<scale_value::Value>::new())
        ))
    )
}
fn param_hash(params: &[Value]) -> u8 {
    params
        .last()
        .and_then(Value::as_str)
        .and_then(|s| s.get(2..4))
        .and_then(|s| u8::from_str_radix(s, 16).ok())
        .unwrap_or(0)
}
async fn setup() -> Result<(String, Arc<Fake>, ServerHandle), Box<dyn std::error::Error>> {
    let server = ServerBuilder::default().build("127.0.0.1:0").await?;
    let addr = server.local_addr()?;
    let fake = Arc::new(Fake::default());
    let mut module = RpcModule::new(fake.clone());
    for method in [
        "chain_getBlockHash",
        "chain_getHeader",
        "chain_getFinalizedHead",
        "state_getStorageHash",
        "state_getRuntimeVersion",
        "state_getMetadata",
        "state_getStorage",
        "state_call",
        "state_getKeysPaged",
        "system_health",
        "system_syncState",
    ] {
        let _ = module.register_async_method(method,move |params,fake,_|async move {
   let params=params.parse::<Vec<Value>>()?;let n=param_hash(&params);let backfill=n>=100;
   let active=fake.active.fetch_add(1,Ordering::SeqCst)+1;let _ = fake.max.fetch_max(active,Ordering::SeqCst);
   if backfill{let active=fake.backfill.fetch_add(1,Ordering::SeqCst)+1;let _ = fake.max_backfill.fetch_max(active,Ordering::SeqCst);}
   let _running=Running{fake:Arc::clone(fake.as_ref()),backfill};
   tokio::time::sleep(Duration::from_millis(5)).await;
   let response=match method {
    "chain_getBlockHash"=>json!(hash(0)),
    "chain_getFinalizedHead"=>json!(hash(3)),
    "chain_getHeader"=>{let mut babe=vec![2];babe.extend(0u32.encode());babe.extend(1_000_005u64.encode());let mut log=vec![6];log.extend(b"BABE");log.extend(babe.encode());json!({"number":format!("0x{n:x}"),"parentHash":hash(n.saturating_sub(1)),"stateRoot":hash(9),"extrinsicsRoot":hash(8),"digest":{"logs":[format!("0x{}",hex::encode(log))]}})},
    "state_getStorageHash"=>json!(hash(if fake.pressure.load(Ordering::SeqCst)>0 {n / 4} else if n<2{11}else{22})),
    "state_getRuntimeVersion"=>json!({"specName":"quip","implName":"fixture","specVersion":if n<2{117}else{118},"transactionVersion":7}),
    "state_getMetadata" if fake.pressure.load(Ordering::SeqCst)>0 => hex(large_metadata(n).map_err(|e| ErrorObjectOwned::owned(-32603,e.to_string(),None::<()>))?),
    "state_getMetadata"=>hex(if n<2{include_bytes!("fixtures/chain/runtime-old-v16.scale").as_slice()}else{include_bytes!("fixtures/chain/runtime-new-v16.scale").as_slice()}),
    "state_getStorage"=>{
      if n==90 {return Err(ErrorObjectOwned::owned(-32000,"State already discarded",None::<()>));}
      let storage=params.first().and_then(Value::as_str).unwrap_or("");
      if storage==key("System","Events") && fake.pressure.load(Ordering::SeqCst)>0 { hex(many_events(fake.pressure.load(Ordering::SeqCst))) }
      else if storage==key("System","Events") {hex(if n==2{include_bytes!("fixtures/chain/events-old.scale").as_slice()}else if n==3{include_bytes!("fixtures/chain/events-new.scale").as_slice()}else{&[0]})}
      else if storage==key("Timestamp","Now") {hex(1_710_000_000_123u64.encode())}
      else if storage==key("Session","Validators") {hex(vec![[n+5;32]].encode())}
      else if storage==key("Babe","CurrentSlot") {hex(1_000_005u64.encode())}
      else if storage==key("QuantumPow","DefaultTopology") {hex([8;32])}
      else {return Err(ErrorObjectOwned::owned(-32601,"fixture storage unsupported",None::<()>));}
    },
    "state_call"=>{let api=params.first().and_then(Value::as_str).unwrap_or("");match api {
      "QuantumPowApi_winning_solution" if fake.winner_failures.fetch_update(Ordering::SeqCst,Ordering::SeqCst, |n| n.checked_sub(1)).is_ok() => return Err(ErrorObjectOwned::owned(-32000,"temporary winner failure",None::<()>)),
      "QuantumPowApi_winning_solution"=>hex(include_bytes!("fixtures/chain/winning-solution.scale")),
      "QuantumPowApi_topology_meta"=>hex(include_bytes!("fixtures/chain/topology.scale")),
      "MinerRegistryApi_participants_by_qblock"=>hex(include_bytes!("fixtures/chain/participants.scale")),
      "MinerRegistryApi_participant_count_by_qblock"=>hex(1u32.encode()),
      "BabeApi_current_epoch"=>hex((77u64,1_000_000u64,2400u64).encode()),
      _=>return Err(ErrorObjectOwned::owned(-32601,"fixture API unsupported",None::<()>)),
    }},
    "state_getKeysPaged"=>json!([]),
    "system_health"=>json!({"isSyncing":false,"peers":3}),
    "system_syncState"=>json!({"currentBlock":3,"highestBlock":3}),
    _=>return Err(ErrorObjectOwned::owned(-32601,"unknown fixture method",None::<()>)),
   };
   fake.calls.lock().map_err(|_|ErrorObjectOwned::owned(-32603,"poisoned test mutex",None::<()>))?.push((method.into(),json!(params),response.to_string().len()));
   Ok::<Value,ErrorObjectOwned>(response)
  })?;
    }
    Ok((format!("http://{addr}"), fake, server.start(module)))
}
#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions report fixture mismatches through the test runner."
)]
async fn concurrent_block_reads_share_events_timestamp_and_solution() -> TestResult {
    let (url, fake, handle) = setup().await?;
    let reader = ChainReader::new(url, hash(0));
    reader.connect().await?;
    let (a, b) = tokio::join!(
        reader.finalized_block(hash(2)),
        reader.finalized_block(hash(2))
    );
    let a = a?;
    let b = b?;
    assert!(Arc::ptr_eq(&a, &b));
    assert_eq!(a.contexts.execution.spec_version, 117);
    assert_eq!(a.contexts.post_state.spec_version, 118);
    assert_eq!(a.events.timestamp, 1_710_000_000);
    let qblock = a.qblock.as_ref().ok_or("missing qblock")?;
    assert_eq!(
        qblock.nonce,
        "115792089237316195423570985008687907853269984665640564039457584007913129639935"
    );
    assert_eq!(qblock.device_access_time_us, Some(u64::MAX));
    let before = fake.calls.lock().map_err(|_| "poisoned")?.len();
    let _ = reader.finalized_block(hash(2)).await?;
    assert_eq!(before, fake.calls.lock().map_err(|_| "poisoned")?.len());
    let calls = fake.calls.lock().map_err(|_| "poisoned")?.clone();
    for entry in ["System.Events", "Timestamp.Now"] {
        let (pallet, name) = entry.split_once('.').ok_or("bad test entry")?;
        assert_eq!(
            calls
                .iter()
                .filter(|(method, params, _)| method == "state_getStorage"
                    && params.get(0) == Some(&json!(key(pallet, name))))
                .count(),
            1
        );
    }
    assert_eq!(
        calls
            .iter()
            .filter(|(m, p, _)| m == "state_call"
                && p.get(0) == Some(&json!("QuantumPowApi_winning_solution")))
            .count(),
        1
    );
    reader.disconnect().await?;
    handle.stop()?;
    Ok(())
}
#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions report fixture mismatches through the test runner."
)]
async fn upgrade_before_boundary_after_and_reopened_metadata() -> TestResult {
    let (url, fake, handle) = setup().await?;
    let reader = ChainReader::new(url.clone(), hash(0));
    reader.connect().await?;
    let before = reader.finalized_block(hash(1)).await?;
    assert!(before.qblock.is_none());
    let upgrade = reader.finalized_block(hash(2)).await?;
    let after = reader.finalized_block(hash(3)).await?;
    assert_eq!(
        (
            before.contexts.execution.spec_version,
            upgrade.contexts.execution.spec_version,
            after.contexts.execution.spec_version
        ),
        (117, 117, 118)
    );
    assert_eq!(
        upgrade.events.author.as_deref(),
        Some(subxt_core::utils::AccountId32([7; 32]).to_string().as_str())
    );
    assert_eq!(
        after.events.author.as_deref(),
        Some(subxt_core::utils::AccountId32([8; 32]).to_string().as_str())
    );
    let records = reader.metadata_records().await;
    reader.disconnect().await?;
    let old_calls = fake
        .calls
        .lock()
        .map_err(|_| "poisoned")?
        .iter()
        .filter(|(m, _, _)| m == "state_getMetadata")
        .count();
    assert_eq!(old_calls, 2);
    let reopened = ChainReader::new(url, hash(0));
    reopened.import_metadata(records).await?;
    reopened.connect().await?;
    let _ = reopened.finalized_block(hash(2)).await?;
    assert_eq!(
        old_calls,
        fake.calls
            .lock()
            .map_err(|_| "poisoned")?
            .iter()
            .filter(|(m, _, _)| m == "state_getMetadata")
            .count()
    );
    reopened.disconnect().await?;
    handle.stop()?;
    Ok(())
}
#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions report fixture mismatches through the test runner."
)]
async fn nonwinner_and_winner_only_do_not_request_unneeded_enrichment() -> TestResult {
    let (url, fake, handle) = setup().await?;
    let reader = ChainReader::new(url, hash(0));
    reader.connect().await?;
    let block = reader
        .block(
            hash(1),
            BlockPurpose::WinnerOnly,
            hash(3),
            WorkClass::Backfill,
        )
        .await?;
    assert!(block.events.author.is_none());
    assert!(block.qblock.is_none());
    assert!(
        !fake
            .calls
            .lock()
            .map_err(|_| "poisoned")?
            .iter()
            .any(|(m, _, _)| m == "state_call")
    );
    assert!(matches!(
        reader.timestamp(hash(90), WorkClass::Backfill).await,
        Err(ChainError::Pruned(_))
    ));
    assert!(
        reader
            .winning_solution(hash(3), 90, WorkClass::Backfill)
            .await?
            .is_some()
    );
    reader.disconnect().await?;
    handle.stop()?;
    Ok(())
}
#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions report fixture mismatches through the test runner."
)]
async fn paging_requires_snapshot_and_qblock_identity() -> TestResult {
    let (url, _, handle) = setup().await?;
    let reader = ChainReader::new(url, hash(0));
    reader.connect().await?;
    assert!(
        reader
            .winner_page(
                hash(3),
                Some(WinnerCursor {
                    at: hash(2),
                    key: vec![]
                }),
                10
            )
            .await
            .is_err()
    );
    assert!(reader.winner_page(hash(3), None, 0).await.is_err());
    assert!(reader.winner_page(hash(3), None, 1001).await.is_err());
    assert!(reader.winner_page(hash(3), None, 10).await?.exhausted);
    let page = reader
        .participant_page(hash(3), 9, None, 1, WorkClass::Live)
        .await?;
    assert!(!page.exhausted);
    assert!(page.continuation.is_some());
    assert!(
        reader
            .participant_page(hash(3), 9, page.continuation, 1, WorkClass::Live)
            .await
            .is_err()
    );
    assert!(
        reader
            .participant_page(
                hash(3),
                9,
                Some(ParticipantCursor {
                    at: hash(2),
                    qblock_id: 9,
                    account: vec![7; 32]
                }),
                1,
                WorkClass::Live
            )
            .await
            .is_err()
    );
    reader.disconnect().await?;
    handle.stop()?;
    Ok(())
}
#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions report fixture mismatches through the test runner."
)]
async fn bounded_rpc_backfill_reserves_live_capacity() -> TestResult {
    let (url, fake, handle) = setup().await?;
    let reader = Arc::new(ChainReader::new(url, hash(0)));
    reader.connect().await?;
    let mut tasks = Vec::new();
    for n in 100..112 {
        let reader = reader.clone();
        tasks.push(tokio::spawn(async move {
            reader.timestamp(hash(n), WorkClass::Backfill).await
        }));
    }
    let mut live = Vec::new();
    for n in 20..24 {
        let reader = reader.clone();
        live.push(tokio::spawn(async move {
            reader.timestamp(hash(n), WorkClass::Live).await
        }));
    }
    for task in live {
        let _ = tokio::time::timeout(Duration::from_secs(2), task).await???;
    }
    for task in tasks {
        let _ = task.await??;
    }
    assert!(fake.max.load(Ordering::SeqCst) <= 4);
    assert!(fake.max_backfill.load(Ordering::SeqCst) <= 2);
    assert!(fake.max.load(Ordering::SeqCst) > 2);
    reader.disconnect().await?;
    handle.stop()?;
    Ok(())
}
#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions report fixture mismatches through the test runner."
)]
async fn topology_counts_cached_and_epoch_start_uses_chain_value() -> TestResult {
    let (url, fake, handle) = setup().await?;
    let reader = ChainReader::new(url.clone(), hash(0));
    reader.connect().await?;
    let (a, b) = tokio::join!(
        reader.topology_summary(hash(3), hash(8), WorkClass::Live),
        reader.topology_summary(hash(3), hash(8), WorkClass::Live)
    );
    let a = a?;
    let _ = b?;
    assert_eq!((a.node_count, a.edge_count), (3, 2));
    assert!(a.curve_constant.is_some_and(|k| k > 4.0 && k < 6.0));
    let epoch = reader.babe_epoch(hash(3), WorkClass::Live).await?;
    assert_eq!(epoch.epoch_start_slot, 1_000_000);
    assert_ne!(
        epoch.epoch_index * epoch.slots_per_epoch,
        epoch.epoch_start_slot
    );
    let cache = reader.topology_records().await;
    reader.disconnect().await?;
    let reopened = ChainReader::new(url, hash(0));
    reopened.import_topologies(hash(0), cache).await?;
    reopened.connect().await?;
    let _ = reopened
        .topology_summary(hash(3), hash(8), WorkClass::Live)
        .await?;
    assert_eq!(
        fake.calls
            .lock()
            .map_err(|_| "poisoned")?
            .iter()
            .filter(|(m, p, _)| m == "state_call"
                && p.get(0) == Some(&json!("QuantumPowApi_topology_meta")))
            .count(),
        1
    );
    reopened.disconnect().await?;
    handle.stop()?;
    Ok(())
}
#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions report fixture mismatches through the test runner."
)]
async fn rejects_wrong_genesis_and_can_discover_identity() -> TestResult {
    let (url, _, handle) = setup().await?;
    assert_eq!(ChainReader::discover_genesis(url.clone()).await?, hash(0));
    let reader = ChainReader::new(url, hash(9));
    assert!(matches!(
        reader.connect().await,
        Err(ChainError::GenesisMismatch { .. })
    ));
    assert!(reader.finalized_head().await.is_err());
    handle.stop()?;
    Ok(())
}

#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions report subscription lifecycle regressions."
)]
async fn reconnect_replaces_both_subscriptions_without_duplicates() -> TestResult {
    struct Active(Arc<AtomicUsize>);
    impl Drop for Active {
        fn drop(&mut self) {
            let _ = self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
    let server = ServerBuilder::default().build("127.0.0.1:0").await?;
    let addr = server.local_addr()?;
    let active = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let mut module = RpcModule::new(());
    let _ = module.register_method("chain_getBlockHash", |_, (), _| json!(hash(0)))?;
    for (subscribe, notification, unsubscribe) in [
        (
            "chain_subscribeNewHeads",
            "chain_newHead",
            "chain_unsubscribeNewHeads",
        ),
        (
            "chain_subscribeFinalizedHeads",
            "chain_finalizedHead",
            "chain_unsubscribeFinalizedHeads",
        ),
    ] {
        let active = active.clone();
        let maximum = maximum.clone();
        let _=module.register_subscription(subscribe,notification,unsubscribe,move|_,pending,_,_| {
            let active=active.clone();let maximum=maximum.clone();
            async move {
                let sink=pending.accept().await?;
                let count=active.fetch_add(1,Ordering::SeqCst)+1;let _=maximum.fetch_max(count,Ordering::SeqCst);
                let _guard=Active(active);
                let header=json!({"number":"0x1","parentHash":hash(0),"stateRoot":hash(1),"extrinsicsRoot":hash(2),"digest":{"logs":[]}});
                sink.send(serde_json::value::to_raw_value(&header)?).await?;
                sink.closed().await;
                Ok::<(),jsonrpsee::core::SubscriptionError>(())
            }
        })?;
    }
    let handle = server.start(module);
    let reader = ChainReader::new(format!("ws://{addr}"), hash(0));
    for _ in 0..2 {
        reader.connect().await?;
        let mut heads = reader.subscribe_heads().await?;
        let _ = reader.subscribe_heads().await?;
        tokio::time::timeout(Duration::from_secs(2), heads.finalized.changed()).await??;
        tokio::time::timeout(Duration::from_secs(2), async {
            while active.load(Ordering::SeqCst) != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await?;
        assert_eq!(active.load(Ordering::SeqCst), 2);
        reader.disconnect().await?;
        tokio::time::timeout(Duration::from_secs(2), async {
            while active.load(Ordering::SeqCst) != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await?;
    }
    assert_eq!(maximum.load(Ordering::SeqCst), 2);
    handle.stop()?;
    Ok(())
}

#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions verify explicit oversized-response errors."
)]
async fn oversized_http_response_is_a_typed_error() -> TestResult {
    let server = ServerBuilder::default()
        .set_config(
            jsonrpsee::server::ServerConfig::builder()
                .max_response_body_size(20 * 1024 * 1024)
                .build(),
        )
        .build("127.0.0.1:0")
        .await?;
    let addr = server.local_addr()?;
    let mut module = RpcModule::new(());
    let _ = module.register_method("chain_getBlockHash", |_, (), _| json!(hash(0)))?;
    let _ = module.register_method("chain_getFinalizedHead", |_, (), _| {
        "x".repeat(17 * 1024 * 1024)
    })?;
    let handle = server.start(module);
    let reader = ChainReader::new(format!("http://{addr}"), hash(0));
    reader.connect().await?;
    let result = reader.finalized_head().await;
    assert!(
        matches!(result, Err(ChainError::Oversized(_))),
        "{result:?}"
    );
    reader.disconnect().await?;
    handle.stop()?;
    Ok(())
}

fn large_metadata(n: u8) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut metadata = frame_metadata::RuntimeMetadataPrefixed::decode(
        &mut include_bytes!("fixtures/chain/runtime-new-v16.scale").as_slice(),
    )?;
    let frame_metadata::RuntimeMetadata::V16(ref mut value) = metadata.1 else {
        return Err("fixture is not V16".into());
    };
    value
        .pallets
        .first_mut()
        .ok_or("missing pallet")?
        .docs
        .push(format!("{n}{}", "x".repeat(1_500_000)));
    Ok(metadata.encode())
}
fn many_events(count: usize) -> Vec<u8> {
    let count = if count == 1 { 2_000 } else { count };
    let mut bytes = Compact(u32::try_from(count).unwrap_or(u32::MAX)).encode();
    for _ in 0..count {
        bytes.extend((1u8, 10u8, 9u8, [7u8; 32], -1400i64, 250u32, 4u32, 0u8).encode());
    }
    bytes
}
#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions verify payload limits and retained Arc accounting under pressure."
)]
async fn payload_pressure_releases_evicted_blocks_and_runtime_leases() -> TestResult {
    let (url, fake, handle) = setup().await?;
    fake.pressure.store(1, Ordering::SeqCst);
    let reader = ChainReader::new(url, hash(0));
    reader.connect().await?;
    let held = reader.finalized_block(hash(20)).await?;
    let minimum = reader.payload_metrics();
    for n in 21..49 {
        let block = reader
            .finalized_block(hash(n))
            .await
            .map_err(|error| format!("height {n}: {error}, {:?}", reader.payload_metrics()))?;
        assert_eq!(block.events.proofs.len(), 2_000);
        let metrics = reader.payload_metrics();
        assert!(metrics.response_bytes <= 12 * 1024 * 1024);
        assert!(metrics.metadata_bytes <= 8 * 1024 * 1024);
        assert!(metrics.block_bytes <= 4 * 1024 * 1024);
        assert!(metrics.peak_bytes <= 24 * 1024 * 1024);
        assert!(reader.metrics().await.cache_entries <= 128);
    }
    let retained = reader.payload_metrics();
    assert!(retained.metadata_bytes >= minimum.metadata_bytes);
    assert_eq!(held.events.proofs.len(), 2_000);
    drop(held);
    assert_eq!(
        reader.payload_metrics().block_bytes,
        retained.block_bytes - minimum.block_bytes
    );
    reader.disconnect().await?;
    handle.stop()?;
    Ok(())
}
#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions verify failed enrichment remains retryable without duplicate block reads."
)]
async fn winner_failure_is_separate_and_retries_without_refetching_events() -> TestResult {
    let (url, fake, handle) = setup().await?;
    fake.winner_failures.store(1, Ordering::SeqCst);
    let reader = ChainReader::new(url, hash(0));
    reader.connect().await?;
    let failed = reader.finalized_block(hash(2)).await?;
    assert!(failed.events.winner.is_some());
    assert!(failed.qblock.is_none());
    assert!(failed.qblock_error.is_some());
    let retried = reader.finalized_block(hash(2)).await?;
    assert!(retried.qblock.is_some());
    assert!(retried.qblock_error.is_none());
    let calls = fake.calls.lock().map_err(|_| "poisoned")?.clone();
    assert_eq!(
        calls
            .iter()
            .filter(|(m, p, _)| m == "state_getStorage"
                && p.get(0) == Some(&json!(key("System", "Events"))))
            .count(),
        1
    );
    drop(calls);
    reader.disconnect().await?;
    handle.stop()?;
    Ok(())
}

#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions verify a valid response larger than the cache share completes once for concurrent consumers."
)]
async fn large_valid_response_is_shared_without_retained_cache_charge() -> TestResult {
    let server = ServerBuilder::default()
        .set_config(
            jsonrpsee::server::ServerConfig::builder()
                .max_response_body_size(20 * 1024 * 1024)
                .build(),
        )
        .build("127.0.0.1:0")
        .await?;
    let addr = server.local_addr()?;
    let calls = Arc::new(AtomicUsize::new(0));
    let mut module = RpcModule::new(calls.clone());
    let _ = module.register_method("chain_getBlockHash", |_, _, _| json!(hash(0)))?;
    let _ = module.register_async_method("chain_getHeader", |_, calls, _| async move {
        let _ = calls.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(10)).await;
        json!({"number":"0x1","parentHash":hash(0),"stateRoot":hash(1),"extrinsicsRoot":hash(2),"digest":{"logs":["x".repeat(13 * 1024 * 1024)]}})
    })?;
    let handle = server.start(module);
    let reader = ChainReader::new(format!("http://{addr}"), hash(0));
    reader.connect().await?;
    let (a, b) = tokio::join!(
        reader.header(hash(1), WorkClass::Live),
        reader.header(hash(1), WorkClass::Live)
    );
    assert_eq!(a?.height()?, 1);
    assert_eq!(b?.height()?, 1);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(reader.payload_metrics().response_bytes, 0);
    assert_eq!(reader.payload_metrics().in_flight_bytes, 0);
    assert_eq!(reader.metrics().await.cache_entries, 0);
    reader.disconnect().await?;
    handle.stop()?;
    Ok(())
}

#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions verify key-order pagination never assumes numeric height order."
)]
async fn winner_pages_follow_blake_keys_and_explicit_exhaustion() -> TestResult {
    let (url, _, handle) = setup().await?;
    let reader = ChainReader::new(url, hash(0));
    reader.connect().await?;
    let context = reader.runtime_context(hash(3), WorkClass::Live).await?;
    let mut keys = Vec::new();
    for height in [1u32, 2, 3, 4, 5] {
        let bytes = subxt_core::storage::get_address_bytes(
            &subxt_core::dynamic::storage(
                "QuantumPow",
                "QBlocks",
                vec![scale_value::Value::u128(u128::from(height))],
            ),
            &context.metadata,
        )?;
        keys.push((bytes, u64::from(height)));
    }
    keys.sort();
    let expected: Vec<_> = keys.iter().map(|(_, height)| *height).collect();
    assert_ne!(expected, vec![1, 2, 3, 4, 5]);
    let server = ServerBuilder::default().build("127.0.0.1:0").await?;
    let addr = server.local_addr()?;
    let mut module = RpcModule::new(keys);
    let _ = module.register_method("chain_getBlockHash", |_, _, _| json!(hash(0)))?;
    let _ = module.register_method("state_getStorageHash", |_, _, _| json!(hash(22)))?;
    let _ = module.register_method("state_getKeysPaged", |params, keys, _| {
        let params: Vec<Value> = params.parse()?;
        let at: BlockHash =
            serde_json::from_value(params.get(3).cloned().unwrap_or(Value::Null))
                .map_err(|e| ErrorObjectOwned::owned(-32602, e.to_string(), None::<()>))?;
        if at != hash(3) {
            return Err(ErrorObjectOwned::owned(
                -32602,
                "snapshot changed",
                None::<()>,
            ));
        }
        let limit = params
            .get(1)
            .and_then(Value::as_u64)
            .and_then(|v| usize::try_from(v).ok())
            .unwrap_or(0);
        let start = params.get(2).and_then(Value::as_str).unwrap_or("");
        let page: Vec<_> = keys
            .iter()
            .map(|(key, _)| format!("0x{}", hex::encode(key)))
            .filter(|key| key.as_str() > start)
            .take(limit)
            .collect();
        Ok::<_, ErrorObjectOwned>(page)
    })?;
    let pages_handle = server.start(module);
    let pages = ChainReader::new(format!("http://{addr}"), hash(0));
    pages
        .import_metadata(reader.metadata_records().await)
        .await?;
    pages.connect().await?;
    let mut cursor = None;
    let mut heights = Vec::new();
    loop {
        let page = pages.winner_page(hash(3), cursor, 2).await?;
        assert_eq!(page.at, hash(3));
        heights.extend(page.heights);
        if page.exhausted {
            assert!(page.continuation.is_none());
            break;
        }
        cursor = page.continuation;
        assert!(cursor.is_some());
    }
    assert_eq!(heights, expected);
    pages.disconnect().await?;
    reader.disconnect().await?;
    pages_handle.stop()?;
    handle.stop()?;
    Ok(())
}

#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions verify large decoded blocks remain shared without retained cache ownership."
)]
async fn large_decoded_block_stays_shared_until_consumers_release_it() -> TestResult {
    let (url, fake, handle) = setup().await?;
    fake.pressure.store(50_000, Ordering::SeqCst);
    let reader = ChainReader::new(url, hash(0));
    reader.connect().await?;
    let (a, b) = tokio::join!(
        reader.finalized_block(hash(20)),
        reader.finalized_block(hash(20))
    );
    let a = a?;
    let b = b?;
    assert!(Arc::ptr_eq(&a, &b));
    assert_eq!(a.events.proofs.len(), 50_000);
    assert_eq!(reader.payload_metrics().block_bytes, 0);
    assert!(reader.payload_metrics().in_flight_bytes > 4 * 1024 * 1024);
    let third = reader.finalized_block(hash(20)).await?;
    assert!(Arc::ptr_eq(&a, &third));
    drop((a, b, third));
    assert_eq!(reader.payload_metrics().in_flight_bytes, 0);
    reader.disconnect().await?;
    handle.stop()?;
    Ok(())
}
