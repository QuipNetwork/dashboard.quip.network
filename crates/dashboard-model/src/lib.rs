// SPDX-License-Identifier: AGPL-3.0-or-later

//! Shared dashboard records, decimal serialization, and public API types.

mod chain;
mod decimal;
mod hash;
mod health;
mod miner;
mod node;
mod response;
mod serde_util;

pub use chain::{
    BabeAuthorityRecord, BabeEpochState, BlockRecord, ChainHead, ChainMinerRecord,
    DifficultyRecord, DifficultySource, MineableTopologyRecord, MinerWinsRow, MiningHistoryRow,
    QBlockParticipationRecord, RuntimeVersion, ValidatorAuthorshipRecord,
};
pub use decimal::{DecimalString, DecimalStringError, DecimalToU64Error};
/// Exact block height on the wire. Protocol arithmetic uses the checked `to_u64` conversion.
pub type BlockHeight = DecimalString;
pub use hash::{BlockHash, BlockHashError};
pub use health::HealthResponse;
pub use miner::{
    CurrentDispatch, DispatchStatus, MinerCategory, MinerHandle, MinerHardwareRecord,
    MinerHardwareSource, MinerStats, MiningAttempt, MiningAttemptsResponse, MiningSubmissionRecord,
    ModeBreakdown, ModeBreakdownMap,
};
pub use node::{
    NodeDescriptor, NodeDescriptorRecord, NodeDescriptorSchema, NodeInfo, NodeLocation,
    NodeMinerEntry, NodeRuntime, NodeSystemCpu, NodeSystemGpu, NodeSystemInfo, NodeSystemOs,
    NodesSnapshot,
};
pub use response::{
    DeviceAccessTimeBackfill, DifficultyHistoryResponse, ErrorResponse, IndexerBackfillProgress,
    IndexerObservability, IndexerPluginCoverage, MinerWinsResponse, MiningHistoryResponse,
    NodeLiveData, NodeSummaryResponse, ParticipationComputeRow, QPU_ACCESS_TO_WALL_RATIO,
    TelemetryFiles, TelemetryResponse,
};

#[cfg(test)]
mod tests {
    #![expect(
        clippy::panic_in_result_fn,
        reason = "deliberate assertion-based unit tests; assertions are the intent, not a check_eq helper"
    )]

    use super::{
        BlockHash, BlockRecord, DecimalString, HealthResponse, IndexerObservability,
        MiningSubmissionRecord, TelemetryFiles, TelemetryResponse,
    };
    use std::error::Error;

    const HASH: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn parse_hash() -> Result<BlockHash, Box<dyn Error>> {
        Ok(HASH.parse()?)
    }

    #[test]
    fn block_record_uses_camel_case_and_decimal_strings() -> Result<(), Box<dyn Error>> {
        let record = BlockRecord {
            block_hash: parse_hash()?,
            substrate_block_number: "4500".parse()?,
            substrate_block_hash: parse_hash()?,
            substrate_parent_hash: parse_hash()?,
            timestamp: 1_700_000_000,
            miner_id: "5GMiner".to_owned(),
            energy: -14.5,
            diversity: 0.4,
            num_valid_solutions: 2,
            mining_time: 12.0,
            device_access_time_us: None,
            reward: "1000000000000".parse()?,
            qblock_id: "42".parse()?,
            nonce: "7".parse()?,
            num_nodes: 64,
            num_edges: 128,
            difficulty_energy: -14.4,
            min_diversity: 0.1,
            min_solutions: 1,
            finalized: true,
            topology_hash: None,
        };
        let json = serde_json::to_value(&record)?;
        assert_eq!(json.get("blockHash"), Some(&serde_json::Value::from(HASH)));
        assert_eq!(
            json.get("substrateBlockNumber"),
            Some(&serde_json::Value::from("4500"))
        );
        assert_eq!(
            json.get("reward"),
            Some(&serde_json::Value::from("1000000000000"))
        );
        assert_eq!(
            json.get("deviceAccessTimeUs"),
            Some(&serde_json::Value::Null)
        );
        assert!(
            json.get("energy")
                .and_then(serde_json::Value::as_f64)
                .is_some()
        );
        let parsed: BlockRecord = serde_json::from_value(json)?;
        assert_eq!(parsed.miner_id, record.miner_id);
        assert_eq!(parsed.reward, record.reward);
        Ok(())
    }

    #[test]
    fn telemetry_response_empty_round_trip() -> Result<(), Box<dyn Error>> {
        let body = TelemetryResponse {
            blocks: Vec::new(),
            self_address: None,
            indexer: None,
            server_time: "2026-05-19T00:00:00Z".to_owned(),
            chain_head: None,
            babe_epoch: None,
            babe_authorities: Vec::new(),
            chain_miners: Vec::new(),
            recent_difficulty: Vec::new(),
            mineable_topologies: Vec::new(),
            validators: Vec::new(),
            nodes: None,
            node_descriptors: Vec::new(),
            recent_mining_submissions: Vec::new(),
            self_problems_attempted: 0,
            current_dispatch: None,
            files: TelemetryFiles {
                qblocks_manifest: "/files/qblocks/metadata.json".to_owned(),
            },
        };
        let json = serde_json::to_value(&body)?;
        assert_eq!(
            json.get("serverTime"),
            Some(&serde_json::Value::from("2026-05-19T00:00:00Z"))
        );
        assert_eq!(json.get("selfAddress"), Some(&serde_json::Value::Null));
        assert_eq!(
            json.get("blocks")
                .and_then(serde_json::Value::as_array)
                .map(Vec::len),
            Some(0)
        );
        let parsed: TelemetryResponse = serde_json::from_value(json)?;
        assert_eq!(parsed.server_time, body.server_time);
        Ok(())
    }

    #[test]
    fn observability_omits_optional_keys_and_keeps_nulls() -> Result<(), Box<dyn Error>> {
        let obs = IndexerObservability {
            chain_head_from_node: Some(DecimalString::from(4939)),
            last_status_fetch_at: "2026-05-19T00:00:00Z".to_owned(),
            last_block_insert_at: None,
            last_substrate_event_at: None,
            best_block_height: None,
            finalized_block_height: None,
            chain_connected: false,
            node_syncing: None,
            node_sync_current_block: None,
            node_sync_highest_block: Some(None),
            self_identified: None,
            miner_stats: None,
            modes: None,
            indexer: None,
            device_access_time_backfill: None,
        };
        let json = serde_json::to_value(&obs)?;
        assert_eq!(
            json.get("chainHeadFromNode"),
            Some(&serde_json::Value::from("4939"))
        );
        assert_eq!(
            json.get("lastBlockInsertAt"),
            Some(&serde_json::Value::Null)
        );
        assert!(json.get("nodeSyncing").is_none());
        assert_eq!(
            json.get("nodeSyncHighestBlock"),
            Some(&serde_json::Value::Null)
        );
        assert!(json.get("modes").is_none());
        Ok(())
    }

    // JSON has one number type; dropping a trailing .0 preserves its exact value.
    // Do not compare through f64: that could hide differences in large integers.
    fn normalize_integer_spelling(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Array(values) => {
                for value in values {
                    normalize_integer_spelling(value);
                }
            }
            serde_json::Value::Object(values) => {
                for value in values.values_mut() {
                    normalize_integer_spelling(value);
                }
            }
            serde_json::Value::Number(number) => {
                if let Some(integer) = number.to_string().strip_suffix(".0")
                    && let Ok(integer) = integer.parse::<serde_json::Number>()
                {
                    *number = integer;
                }
            }
            _ => {}
        }
    }

    #[test]
    fn populated_telemetry_matches_captured_api() -> Result<(), Box<dyn Error>> {
        let mut expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../quip-dashboard/tests/fixtures/api/telemetry-populated.json"
        ))?;
        let response: TelemetryResponse = serde_json::from_value(expected.clone())?;
        let mut actual = serde_json::to_value(response)?;
        normalize_integer_spelling(&mut actual);
        normalize_integer_spelling(&mut expected);
        assert_eq!(actual, expected);
        Ok(())
    }

    #[test]
    fn chain_head_preserves_existing_api_field_names() -> Result<(), Box<dyn Error>> {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../quip-dashboard/tests/fixtures/api/telemetry-populated.json"
        ))?;
        let expected = fixture
            .get("chainHead")
            .ok_or("missing chain head fixture")?;
        let head: crate::ChainHead = serde_json::from_value(expected.clone())?;
        assert_eq!(serde_json::to_value(head)?, *expected);
        Ok(())
    }

    #[test]
    fn mining_submission_preserves_sentinel_last_proof_block_hash() -> Result<(), Box<dyn Error>> {
        // Existing golden miner rows carry a `0x0` sentinel (or empty string)
        // for lastProofBlockHash when no proof has landed. The DTO must accept
        // and preserve that verbatim rather than demanding a 32-byte hash.
        let record = MiningSubmissionRecord {
            solution_number: 5,
            miner_id: "5GMiner".to_owned(),
            miner_type: "CPU".to_owned(),
            ts_ns: "1700000000000000000".parse()?,
            energy_milli: -14500,
            diversity_milli: 400,
            threshold_milli: -14000,
            last_proof_block_hash: "0x0".to_owned(),
            extrinsic_hash: None,
            chain_block_hash: None,
            chain_block_number: None,
            pow_sequence: Some(12),
            outcome: "rejected".to_owned(),
            attempt_count: 3,
            best_energy_milli: -15000,
            num_valid: 1,
            qpu_access_time_us: 0,
            observed_at: "2026-05-19T00:00:00Z".to_owned(),
            chain_only: None,
        };
        let json = serde_json::to_value(&record)?;
        assert_eq!(
            json.get("lastProofBlockHash"),
            Some(&serde_json::Value::from("0x0"))
        );
        let parsed: MiningSubmissionRecord = serde_json::from_value(json)?;
        assert_eq!(parsed.last_proof_block_hash, "0x0");
        assert_eq!(parsed.solution_number, 5);
        Ok(())
    }

    #[test]
    fn health_response_matches_current_fields() -> Result<(), Box<dyn Error>> {
        let body = HealthResponse {
            ok: true,
            last_status_fetch_at: None,
            last_block_insert_at: None,
            last_substrate_event_at: None,
            chain_connected: false,
        };
        let json = serde_json::to_value(&body)?;
        assert_eq!(json.get("ok"), Some(&serde_json::Value::Bool(true)));
        assert_eq!(
            json.get("chainConnected"),
            Some(&serde_json::Value::Bool(false))
        );
        Ok(())
    }
}
