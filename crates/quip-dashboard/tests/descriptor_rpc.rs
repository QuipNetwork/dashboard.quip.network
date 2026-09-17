//! Descriptor provenance deduplication and paging error regression tests.
use jsonrpsee::{RpcModule, server::ServerBuilder, types::ErrorObjectOwned};
use parity_scale_codec::{Decode, Encode};
use quip_dashboard::chain::{BlockHash, ChainError, ChainReader, WorkClass};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU8, Ordering},
};

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[derive(Default)]
struct DescriptorRpc {
    calls: Mutex<Vec<(String, Value)>>,
    keys: Vec<String>,
    pruned: AtomicBool,
    oversize: AtomicBool,
    hash_offset: AtomicU8,
}

fn hash(n: u8) -> BlockHash {
    BlockHash([n; 32])
}
fn storage_key(pallet: &str, name: &str) -> String {
    format!(
        "0x{}",
        hex::encode(subxt_core::storage::get_address_root_bytes(
            &subxt_core::dynamic::storage(pallet, name, Vec::<scale_value::Value>::new()),
        ))
    )
}
fn response_error(message: &str) -> ErrorObjectOwned {
    ErrorObjectOwned::owned(-32000, message, None::<()>)
}
async fn setup() -> Result<
    (
        ChainReader,
        Arc<DescriptorRpc>,
        jsonrpsee::server::ServerHandle,
    ),
    Box<dyn std::error::Error>,
> {
    let metadata = subxt_core::Metadata::decode(
        &mut include_bytes!("fixtures/chain/runtime-descriptors-v16.scale").as_slice(),
    )?;
    let mut fixture = DescriptorRpc::default();
    for account in 1u8..=3 {
        let key = subxt_core::storage::get_address_bytes(
            &subxt_core::dynamic::storage(
                "MinerRegistry",
                "NodeDescriptors",
                vec![scale_value::Value::from_bytes([account; 32])],
            ),
            &metadata,
        )?;
        fixture.keys.push(format!("0x{}", hex::encode(key)));
    }
    fixture.keys.sort();
    let fixture = Arc::new(fixture);
    let server = ServerBuilder::default().build("127.0.0.1:0").await?;
    let addr = server.local_addr()?;
    let mut module = RpcModule::new(fixture.clone());
    for method in [
        "chain_getBlockHash",
        "state_getStorageHash",
        "state_getRuntimeVersion",
        "state_getMetadata",
        "state_getKeysPaged",
        "state_getStorage",
    ] {
        let _ = module.register_method(method, move |params, fixture, _| {
            let params: Vec<Value> = params.parse()?;
            fixture.calls.lock().map_err(|_| response_error("test lock poisoned"))?.push((method.into(), json!(params)));
            let first = params.first().and_then(Value::as_str).unwrap_or("");
            let response = match method {
                "chain_getBlockHash" => {
                    let height = first.strip_prefix("0x").and_then(|n| u8::from_str_radix(n, 16).ok()).unwrap_or(0);
                    json!(hash(if height == 0 { 0 } else { height + fixture.hash_offset.load(Ordering::SeqCst) }))
                },
                "state_getStorageHash" => json!(hash(22)),
                "state_getRuntimeVersion" => json!({"specName":"quip", "implName":"fixture", "specVersion":118, "transactionVersion":7}),
                "state_getMetadata" => json!(format!("0x{}", hex::encode(include_bytes!("fixtures/chain/runtime-descriptors-v16.scale")))),
                "state_getKeysPaged" => {
                    if fixture.oversize.load(Ordering::SeqCst) { return Err(response_error("Response too large")); }
                    json!(fixture.keys)
                },
                "state_getStorage" => {
                    if first == storage_key("Timestamp", "Now") {
                        if fixture.pruned.load(Ordering::SeqCst) { return Err(response_error("State already discarded")); }
                        let block = params.get(1).and_then(Value::as_str).and_then(|s| s.get(2..4)).and_then(|n| u8::from_str_radix(n, 16).ok()).ok_or_else(|| response_error("missing state"))?;
                        json!(format!("0x{}", hex::encode((1_710_000_000_000u64 + u64::from(block) * 1000).encode())))
                    } else {
                        let key = hex::decode(first.strip_prefix("0x").unwrap_or("")).map_err(|_| response_error("invalid key"))?;
                        let account = *key.last().ok_or_else(|| response_error("missing account"))?;
                        let height = if account == 3 { 6u32 } else { 5u32 };
                        let descriptor = (1u32, b"fixture-node".to_vec(), vec![b"https://fixture.invalid/rpc".to_vec()], 0u8, Vec::<()>::new(), height).encode();
                        json!(format!("0x{}", hex::encode(descriptor)))
                    }
                },
                _ => return Err(response_error("unknown method")),
            };
            Ok::<_, ErrorObjectOwned>(response)
        })?;
    }
    let handle = server.start(module);
    let reader = ChainReader::new(format!("http://{addr}"), hash(0));
    reader.connect().await?;
    fixture
        .calls
        .lock()
        .map_err(|_| "test lock poisoned")?
        .clear();
    Ok((reader, fixture, handle))
}

#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions verify one provenance lookup per distinct update height within each page."
)]
async fn descriptor_page_deduplicates_heights_without_cross_snapshot_cache() -> TestResult {
    let (reader, fixture, handle) = setup().await?;
    let expected = json!({"schema":"quip.node_descriptor.v1", "descriptorVersion":1, "nodeName":"fixture-node", "rpcEndpoints":["https://fixture.invalid/rpc"], "logLevel":"Info"});
    for (snapshot, offset) in [(3u8, 0u8), (4, 10)] {
        fixture.hash_offset.store(offset, Ordering::SeqCst);
        fixture
            .calls
            .lock()
            .map_err(|_| "test lock poisoned")?
            .clear();
        let (page, continuation) = reader
            .descriptor_page(hash(snapshot), None, WorkClass::Backfill)
            .await?;
        assert_eq!(page.len(), 3);
        assert!(continuation.is_none());
        for entry in &page {
            let height = if entry.account == [3; 32] { 6u8 } else { 5u8 };
            assert_eq!(entry.updated_at, u64::from(height));
            assert_eq!(entry.block_hash, hash(height + offset));
            assert_eq!(entry.timestamp, 1_710_000_000 + u64::from(height + offset));
            assert_eq!(entry.descriptor, expected);
            assert_eq!(
                entry.account_id,
                subxt_core::utils::AccountId32(entry.account).to_string()
            );
        }
        let calls = fixture
            .calls
            .lock()
            .map_err(|_| "test lock poisoned")?
            .clone();
        assert_eq!(
            calls
                .iter()
                .filter(|(method, _)| method == "chain_getBlockHash")
                .count(),
            2
        );
        assert_eq!(
            calls
                .iter()
                .filter(|(method, params)| method == "state_getStorage"
                    && params.get(0) == Some(&json!(storage_key("Timestamp", "Now"))))
                .count(),
            2
        );
        let first = page.first().ok_or("missing descriptor")?;
        let targeted = reader
            .descriptor_at(hash(snapshot), first.account, WorkClass::Backfill)
            .await?
            .ok_or("missing targeted descriptor")?;
        assert_eq!(targeted.fields, first.fields);
        assert_eq!(targeted.descriptor, first.descriptor);
        assert_eq!(targeted.updated_at, first.updated_at);
        assert_eq!(targeted.timestamp, first.timestamp);
        assert_eq!(targeted.block_hash, first.block_hash);
    }
    reader.disconnect().await?;
    handle.stop()?;
    Ok(())
}

#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions verify unavailable provenance cannot become a successful descriptor page."
)]
async fn descriptor_provenance_pruning_remains_an_error() -> TestResult {
    let (reader, fixture, handle) = setup().await?;
    fixture.pruned.store(true, Ordering::SeqCst);
    assert!(matches!(
        reader
            .descriptor_page(hash(3), None, WorkClass::Backfill)
            .await,
        Err(ChainError::Pruned(_))
    ));
    reader.disconnect().await?;
    handle.stop()?;
    Ok(())
}

#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions verify oversize key pages cannot return a completed enumeration."
)]
async fn oversized_pages_propagate_without_completion() -> TestResult {
    let (reader, fixture, handle) = setup().await?;
    fixture.oversize.store(true, Ordering::SeqCst);
    assert!(matches!(
        reader.winner_page(hash(3), None, 1000).await,
        Err(ChainError::Oversized(_))
    ));
    assert!(matches!(
        reader
            .miner_page(hash(3), None, 1000, WorkClass::Backfill)
            .await,
        Err(ChainError::Oversized(_))
    ));
    assert!(matches!(
        reader
            .descriptor_page(hash(3), None, WorkClass::Backfill)
            .await,
        Err(ChainError::Oversized(_))
    ));
    reader.disconnect().await?;
    handle.stop()?;
    Ok(())
}
