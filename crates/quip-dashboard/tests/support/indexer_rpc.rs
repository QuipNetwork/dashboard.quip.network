// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared real SCALE replay RPC fixture.
use super::BlockHash;
use jsonrpsee::{
    RpcModule,
    server::{ServerBuilder, ServerHandle},
    types::ErrorObjectOwned,
};
use parity_scale_codec::Encode;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

#[derive(Default)]
pub(super) struct Fake {
    pub(super) replay_winners: AtomicBool,
    pub(super) missing_height: AtomicU64,
    pub(super) solution_calls: Mutex<Vec<u64>>,
    pub(super) fail_participation: AtomicBool,
    pub(super) fail_solution: AtomicBool,
    pub(super) absent_solution: AtomicBool,
    pub(super) hold_solution: AtomicBool,
    pub(super) solution_entered: tokio::sync::Notify,
    pub(super) solution_released: tokio::sync::Notify,
}
impl Fake {
    pub(super) fn solution_call_count(&self) -> Result<usize, Box<dyn std::error::Error>> {
        Ok(self
            .solution_calls
            .lock()
            .map_err(|_| "calls poisoned")?
            .len())
    }
}
pub(super) fn hash(n: u8) -> BlockHash {
    BlockHash([n; 32])
}
fn bytes(value: impl AsRef<[u8]>) -> Value {
    json!(format!("0x{}", hex::encode(value)))
}
fn key(pallet: &str, entry: &str) -> String {
    format!(
        "0x{}",
        hex::encode(subxt_core::storage::get_address_root_bytes(
            &subxt_core::dynamic::storage(pallet, entry, Vec::<scale_value::Value>::new())
        ))
    )
}
pub(super) async fn server() -> Result<(String, Arc<Fake>, ServerHandle), Box<dyn std::error::Error>>
{
    let server = ServerBuilder::default().build("127.0.0.1:0").await?;
    let address = server.local_addr()?;
    let fake = Arc::new(Fake::default());
    let mut rpc = RpcModule::new(fake.clone());
    for method in [
        "chain_getBlockHash",
        "chain_getHeader",
        "chain_getFinalizedHead",
        "state_getStorageHash",
        "state_getRuntimeVersion",
        "state_getMetadata",
        "state_getStorage",
        "state_call",
    ] {
        let _=rpc.register_async_method(method,move |params,fake,_|async move {
            let p=params.parse::<Option<Vec<Value>>>()?.unwrap_or_default();
            let n=p.last().and_then(Value::as_str).and_then(|s|s.get(2..4)).and_then(|s|u8::from_str_radix(s,16).ok()).unwrap_or(0);
            let value=match method {
                "chain_getBlockHash"=>{let n=p.first().and_then(|v|v.as_u64().or_else(||v.as_str().and_then(|s|u64::from_str_radix(s.trim_start_matches("0x"),16).ok()))).unwrap_or(0);json!(hash(u8::try_from(n).map_err(|_|ErrorObjectOwned::owned(-32602,"fixture height overflow",None::<()>))?))},
                "chain_getHeader"=>{let mut babe=vec![2];babe.extend(0u32.encode());babe.extend(1_000_005u64.encode());let mut digest=vec![6];digest.extend(b"BABE");digest.extend(babe.encode());json!({"number":format!("0x{n:x}"),"parentHash":hash(n.saturating_sub(1)),"stateRoot":hash(9),"extrinsicsRoot":hash(8),"digest":{"logs":[format!("0x{}",hex::encode(digest))]}})},
                "chain_getFinalizedHead"=>json!(hash(if fake.replay_winners.load(Ordering::SeqCst){40}else{3})),
                "state_getStorageHash"=>json!(hash(if n<2{11}else{22})),
                "state_getRuntimeVersion"=>json!({"specName":"quip","implName":"fixture","specVersion":if n<2{117}else{118},"transactionVersion":7}),
                "state_getMetadata"=>bytes(if n<2{include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/chain/runtime-old-v16.scale")).as_slice()}else{include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/chain/runtime-new-v16.scale")).as_slice()}),
                "state_getStorage"=>{
                    let entry=p.first().and_then(Value::as_str).unwrap_or("");
                    if entry==key("System","Events") {bytes(if n==2{include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/chain/events-old.scale")).as_slice()}else if n==3 || (n>3 && fake.replay_winners.load(Ordering::SeqCst)){include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/chain/events-new.scale")).as_slice()}else{&[0]})}
                    else if entry==key("Timestamp","Now") {bytes(1_710_000_000_000u64.encode())}
                    else if entry==key("Session","Validators") {bytes(vec![[7u8;32]].encode())}
                    else if entry==key("QuantumPow","DefaultTopology") {bytes([8;32])}
                    else if entry==key("QuantumPow","LastProofBlock") {bytes(1u32.encode())}
                    else if entry.starts_with(&key("QuantumPow","Miners")) {Value::Null}
                    else{return Err(ErrorObjectOwned::owned(-32601,"fixture storage unsupported",None::<()>));}
                },
                "state_call"=>match p.first().and_then(Value::as_str).unwrap_or("") {
                    "QuantumPowApi_winning_solution"=>{
let input=hex::decode(p.get(1).and_then(Value::as_str).unwrap_or("").trim_start_matches("0x")).map_err(|_|ErrorObjectOwned::owned(-32602,"invalid height",None::<()>))?;
let height=input.iter().take(8).enumerate().fold(0_u64, |n,(i,b)|n | (u64::from(*b) << (i*8)));
fake.solution_calls.lock().map_err(|_|ErrorObjectOwned::owned(-32603,"poisoned calls",None::<()>))?.push(height);
if height==fake.missing_height.load(Ordering::SeqCst){return Ok(bytes([0]));}
if fake.hold_solution.load(Ordering::SeqCst){fake.solution_entered.notify_one();fake.solution_released.notified().await;}
if fake.absent_solution.load(Ordering::SeqCst){return Ok(bytes([0]));}
if fake.fail_solution.load(Ordering::SeqCst){return Err(ErrorObjectOwned::owned(-32000,"solution unavailable",None::<()>));}bytes(include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/chain/winning-solution.scale")))},
                    "QuantumPowApi_topology_meta"=>bytes(include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/chain/topology.scale"))),
                    "MinerRegistryApi_participants_by_qblock"=>{if fake.fail_participation.load(Ordering::SeqCst){return Err(ErrorObjectOwned::owned(-32000,"participation unavailable",None::<()>));}
{let mut record=vec![4];record.extend([7_u8;32]);let input=hex::decode(p.get(1).and_then(Value::as_str).unwrap_or("").trim_start_matches("0x")).map_err(|_|ErrorObjectOwned::owned(-32602,"invalid participant arguments",None::<()>))?;record.extend(input.get(..8).ok_or_else(||ErrorObjectOwned::owned(-32602,"missing qblock argument",None::<()>))?);record.extend([2,1]);record.extend(60_u32.encode());record.extend(2_u32.encode());bytes(record)}},
                    api=>return Err(ErrorObjectOwned::owned(-32601,format!("fixture API unsupported {api}"),None::<()>)),
                },
                method=>return Err(ErrorObjectOwned::owned(-32601,format!("fixture method unsupported {method}"),None::<()>)),
            };
            Ok::<Value,ErrorObjectOwned>(value)
        })?;
    }
    Ok((format!("http://{address}"), fake, server.start(rpc)))
}
