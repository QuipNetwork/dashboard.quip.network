//! Chain byte fixtures and bounded transport regression tests.
/// Blake2.
use blake2::{Blake2b, Digest, digest::consts::U32};
use parity_scale_codec::{Decode, Encode};
use quip_dashboard::chain::{
    BabeDigest, BlockHash, MetadataRecord, RuntimeVersionInfo, decode_events, decode_extrinsics,
};

type TestResult = Result<(), Box<dyn std::error::Error>>;
fn metadata(new: bool) -> Result<subxt_core::Metadata, Box<dyn std::error::Error>> {
    let bytes: &[u8] = if new {
        include_bytes!("fixtures/chain/runtime-new-v16.scale")
    } else {
        include_bytes!("fixtures/chain/runtime-old-v16.scale")
    };
    Ok(subxt_core::Metadata::decode(&mut &bytes[..])?)
}
#[test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions report fixture mismatches through the test runner."
)]
fn byte_fixtures_keep_large_integers_and_negative_energy() -> TestResult {
    let events = decode_events(
        include_bytes!("fixtures/chain/events-old.scale"),
        &metadata(false)?,
    )?;
    let winner = events.winner.ok_or("missing winner")?;
    assert_eq!(winner.qblock_id, 9_007_199_254_740_993);
    assert_eq!(winner.reward, u128::MAX.to_string());
    assert_eq!(winner.energy_milli, -1400);
    assert_eq!(events.proofs.len(), 1);
    assert_eq!(
        winner.miner,
        subxt_core::utils::AccountId32([7; 32]).to_string()
    );
    Ok(())
}
#[test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions report fixture mismatches through the test runner."
)]
fn metadata_layout_change_cannot_decode_with_wrong_runtime() -> TestResult {
    let old = metadata(false)?;
    let new = metadata(true)?;
    assert!(decode_events(include_bytes!("fixtures/chain/events-old.scale"), &new).is_err());
    assert!(decode_events(include_bytes!("fixtures/chain/events-new.scale"), &old).is_err());
    let events = decode_events(include_bytes!("fixtures/chain/events-new.scale"), &new)?;
    assert_eq!(events.winner.ok_or("missing winner")?.block_number, 3);
    Ok(())
}
#[test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions report fixture mismatches through the test runner."
)]
fn malformed_event_vectors_never_turn_into_empty_success() -> TestResult {
    let metadata = metadata(false)?;
    for bytes in [vec![], vec![255], vec![4], vec![0, 0], vec![8, 1, 10]] {
        assert!(decode_events(&bytes, &metadata).is_err());
    }
    assert!(decode_events(&[0], &metadata)?.proofs.is_empty());
    Ok(())
}
#[test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions report fixture mismatches through the test runner."
)]
fn mixed_signed_v4_and_bare_v5_use_metadata_signature_layout() -> TestResult {
    let extrinsics = decode_extrinsics(
        vec![
            include_bytes!("fixtures/chain/signed-v4.scale").to_vec(),
            include_bytes!("fixtures/chain/bare-v5.scale").to_vec(),
        ],
        &metadata(true)?,
    )?;
    let signed = extrinsics.first().ok_or("missing signed extrinsic")?;
    assert_eq!(signed.signature_bytes.as_ref().map(Vec::len), Some(1660));
    assert_eq!(signed.pallet, "System");
    assert_eq!(signed.call, "Remark");
    assert!(
        extrinsics
            .get(1)
            .ok_or("missing bare extrinsic")?
            .signature_bytes
            .is_none()
    );
    let mut truncated = include_bytes!("fixtures/chain/signed-v4.scale").to_vec();
    let _ = truncated.pop();
    assert!(decode_extrinsics(vec![truncated], &metadata(true)?).is_err());
    Ok(())
}
#[test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions report fixture mismatches through the test runner."
)]
fn babe_digest_preserves_large_slot_and_absent_author() -> TestResult {
    let mut payload = vec![2];
    payload.extend(3u32.encode());
    payload.extend(u64::MAX.encode());
    let mut log = vec![6];
    log.extend(b"BABE");
    log.extend(payload.encode());
    let digest =
        BabeDigest::from_logs(&[format!("0x{}", hex::encode(&log))])?.ok_or("missing digest")?;
    assert_eq!(digest.authority_index, 3);
    assert_eq!(digest.slot, u64::MAX);
    assert_eq!(BabeDigest::from_logs(&[])?, None);
    log.push(0);
    assert!(BabeDigest::from_logs(&[format!("0x{}", hex::encode(log))]).is_err());
    Ok(())
}
#[test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Assertions report fixture mismatches through the test runner."
)]
fn metadata_record_rejects_corruption_and_unsupported_version() -> TestResult {
    let bytes = include_bytes!("fixtures/chain/runtime-new-v16.scale").to_vec();
    let hash = BlockHash(Blake2b::<U32>::digest(&bytes).into());
    let mut record = MetadataRecord {
        genesis: BlockHash([1; 32]),
        state_hash: BlockHash([2; 32]),
        code_hash: BlockHash([3; 32]),
        metadata_hash: hash,
        version: RuntimeVersionInfo {
            spec_name: "quip".into(),
            spec_version: 118,
            transaction_version: 7,
            impl_name: "fixture".into(),
        },
        bytes,
    };
    assert_eq!(record.context(record.state_hash)?.spec_version, 118);
    record.bytes.push(0);
    assert!(record.context(record.state_hash).is_err());
    Ok(())
}
