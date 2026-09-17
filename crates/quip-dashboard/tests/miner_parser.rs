// SPDX-License-Identifier: AGPL-3.0-or-later
//! Captured miner responses preserve numeric and sentinel semantics.
#![expect(
    clippy::panic_in_result_fn,
    reason = "Assertions report fixture contract violations"
)]
use quip_dashboard::miner::parse;
use serde_json::Value;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn response(name: &str) -> Result<Value, Box<dyn std::error::Error>> {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/miner/dashboard_rest_golden.json"))?;
    Ok(parse::unwrap_envelope(
        fixture.get(name).ok_or("missing fixture scenario")?.clone(),
    )?)
}

#[test]
fn captured_status_keeps_identity_and_large_balances() -> TestResult {
    let raw = response("normal/status")?;
    let status = parse::parse_node_status(&raw);
    assert_eq!(
        status.ss58_address,
        "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
    );
    assert_eq!(status.chain_head_number, 10_249);
    assert!(status.is_mining);
    let info = status.miner_info.ok_or("missing registration")?;
    assert_eq!(info.deposit, "1000000000000");
    assert_eq!(info.rewards_earned, "70000000000000");
    assert_eq!(
        parse::parse_status_primary_miner_id(&raw).as_deref(),
        Some("cpu-0")
    );
    Ok(())
}

#[test]
fn captured_sentinel_energy_is_not_a_real_measurement() -> TestResult {
    let parsed =
        parse::parse_mining_attempts_api_response(&response("all_sentinel/mining_attempts")?)?;
    assert_eq!(parsed.submission.energy_milli, 0);
    assert_eq!(parsed.submission.best_energy_milli, -500);
    assert_eq!(
        parsed
            .attempts
            .iter()
            .map(|a| a.best_energy_milli)
            .collect::<Vec<_>>(),
        [-500, 0]
    );
    assert_eq!(parsed.submission.pow_sequence, None);
    Ok(())
}

#[test]
fn captured_submission_preserves_chain_provenance() -> TestResult {
    let parsed =
        parse::parse_mining_attempts_api_response(&response("submitted/mining_attempts")?)?;
    let submission = parsed.submission;
    assert_eq!(submission.threshold_milli, -2_500_000);
    assert_eq!(
        submission.last_proof_block_hash,
        format!("0x{}", "11".repeat(32))
    );
    assert_eq!(
        submission.extrinsic_hash,
        Some(format!("0x{}", "22".repeat(32)))
    );
    assert_eq!(
        submission.chain_block_hash,
        Some(format!("0x{}", "33".repeat(32)))
    );
    assert_eq!(submission.chain_block_number.as_deref(), Some("10249"));
    assert_eq!(submission.pow_sequence, Some(412));
    Ok(())
}

#[test]
fn captured_device_time_overflow_is_rejected() -> TestResult {
    let parsed =
        parse::parse_mining_attempts_api_response(&response("huge_device_time/mining_attempts")?)?;
    assert_eq!(parsed.submission.qpu_access_time_us, 0);
    Ok(())
}

#[test]
fn unsuccessful_envelope_is_an_error() {
    assert_eq!(
        parse::unwrap_envelope(serde_json::json!({"success":false,"error":"boom"})),
        Err(parse::MinerError::EnvelopeFailure("boom".into()))
    );
}
