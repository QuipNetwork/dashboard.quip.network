//! Offline regression checks for one finalized block captured from a validator.
use parity_scale_codec::{Compact, Decode};
use quip_dashboard::chain::{
    BlockHash, Header, MetadataRecord, RuntimeContext, RuntimeVersionInfo, decode_events,
    decode_extrinsics,
};
use serde::Deserialize;
use std::collections::BTreeMap;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Provenance {
    genesis: BlockHash,
    execution_state: BlockHash,
    finalized_hash: BlockHash,
    runtime_code_hash: BlockHash,
    metadata_hash: BlockHash,
    runtime_version: RuntimeVersionInfo,
    block_number: u64,
    rpc_count: u32,
    response_bytes: usize,
}

#[derive(Deserialize)]
struct CapturedBlock {
    block: CapturedBody,
}

#[derive(Deserialize)]
struct CapturedBody {
    header: Header,
    extrinsics: Vec<String>,
}

fn metadata(provenance: &Provenance) -> Result<RuntimeContext, quip_dashboard::chain::ChainError> {
    let record = MetadataRecord {
        genesis: provenance.genesis,
        state_hash: provenance.execution_state,
        code_hash: provenance.runtime_code_hash,
        metadata_hash: provenance.metadata_hash,
        version: provenance.runtime_version.clone(),
        bytes: include_bytes!("fixtures/chain-live/metadata.scale").to_vec(),
    };
    record.context(record.state_hash)
}

#[test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions protect the captured block identity and actual event outcomes."
)]
fn finalized_events_decode_with_real_parent_state_metadata() -> TestResult {
    let provenance: Provenance =
        serde_json::from_slice(include_bytes!("fixtures/chain-live/provenance.json"))?;
    let block: CapturedBlock =
        serde_json::from_slice(include_bytes!("fixtures/chain-live/block.json"))?;
    let context = metadata(&provenance)?;
    assert_eq!(context.spec_version, 117);
    assert_eq!(block.block.header.parent_hash, context.state_hash);
    assert_eq!(block.block.header.height()?, provenance.block_number);
    assert_eq!(provenance.block_number, 205_970);
    assert_eq!(
        provenance.finalized_hash.to_string(),
        "0x6ce62de2b827cf0acefe3c4818b9d0c0ac8497f9cc42be0e4594d41facfa5899"
    );
    assert_eq!(provenance.rpc_count, 7);
    assert_eq!(provenance.response_bytes, 381_240);
    let bytes = include_bytes!("fixtures/chain-live/events.scale");
    let events = decode_events(bytes, &context.metadata)?;
    assert!(events.winner.is_none());
    assert!(events.proofs.is_empty());
    assert!(events.registry_changes.is_empty());
    assert!(events.miner_changes.is_empty());

    let decoded = subxt_core::events::decode_from::<subxt_core::config::SubstrateConfig>(
        bytes.to_vec(),
        context.metadata,
    );
    let mut counts = BTreeMap::new();
    for event in decoded.iter() {
        let event = event?;
        *counts
            .entry(format!("{}.{}", event.pallet_name(), event.variant_name()))
            .or_insert(0u32) += 1;
    }
    assert_eq!(counts.values().sum::<u32>(), 33);
    assert_eq!(
        counts,
        BTreeMap::from([
            ("System.ExtrinsicSuccess".into(), 1),
            ("System.ExtrinsicFailed".into(), 8),
            ("Balances.Withdraw".into(), 8),
            ("Balances.BurnedDebt".into(), 8),
            ("TransactionPayment.TransactionFeePaid".into(), 8),
        ])
    );
    Ok(())
}

#[test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions verify actual V4 signatures and V5 bare calls against captured metadata."
)]
fn real_signed_participation_and_bare_timestamp_extrinsics_decode() -> TestResult {
    let provenance: Provenance =
        serde_json::from_slice(include_bytes!("fixtures/chain-live/provenance.json"))?;
    let block: CapturedBlock =
        serde_json::from_slice(include_bytes!("fixtures/chain-live/block.json"))?;
    let mut encoded = Vec::new();
    let mut versions = Vec::new();
    for extrinsic in block.block.extrinsics {
        let bytes = hex::decode(extrinsic.strip_prefix("0x").ok_or("missing hex prefix")?)?;
        let mut body = bytes.as_slice();
        let declared_length = Compact::<u32>::decode(&mut body)?.0;
        assert_eq!(usize::try_from(declared_length)?, body.len());
        versions.push(*body.first().ok_or("missing extrinsic version")?);
        encoded.push(bytes);
    }
    assert_eq!(
        versions,
        [5, 0x84, 0x84, 0x84, 0x84, 0x84, 0x84, 0x84, 0x84]
    );
    let decoded = decode_extrinsics(encoded, &metadata(&provenance)?.metadata)?;
    assert_eq!(decoded.len(), 9);
    let timestamp = decoded.first().ok_or("missing timestamp")?;
    assert_eq!(timestamp.pallet, "Timestamp");
    assert_eq!(timestamp.call, "set");
    assert!(timestamp.address_bytes.is_none());
    assert!(timestamp.signature_bytes.is_none());
    for participation in decoded.iter().skip(1) {
        assert_eq!(participation.pallet, "MinerRegistry");
        assert_eq!(participation.call, "participate");
        assert!(participation.address_bytes.is_some());
        assert_eq!(
            participation.signature_bytes.as_ref().map(Vec::len),
            Some(1660)
        );
    }
    Ok(())
}
