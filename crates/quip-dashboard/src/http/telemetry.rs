// SPDX-License-Identifier: AGPL-3.0-or-later
use super::{
    HttpState,
    routes::{ApiError, best_effort},
};
use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use dashboard_model::{NodeInfo, NodesSnapshot, TelemetryFiles, TelemetryResponse, ValidatorAuthorshipRecord};
use serde_json::json;
use std::{collections::BTreeMap, time::Duration};
use tokio::time::Instant;
#[derive(Default)]
pub(super) struct SnapshotCache {
    payload: Option<(Instant, Bytes)>,
}
pub(super) async fn get(State(state): State<HttpState>) -> Result<Response, ApiError> {
    // The mutex is also the single-flight gate. Bytes keep their quota until
    // both the cache and every in-flight HTTP body release their shared owner.
    let mut cache = state.cache.lock().await;
    let bytes = if let Some((expires, bytes)) = &cache.payload {
        if *expires > Instant::now() {
            Some(bytes.clone())
        } else {
            None
        }
    } else {
        None
    };
    let bytes = if let Some(bytes) = bytes {
        bytes
    } else {
        cache.payload = None;
        let snapshot = Box::pin(build(&state)).await?;
        let bytes = super::response::encode(&state, &snapshot)?;
        cache.payload = Some((Instant::now() + Duration::from_secs(1), bytes.clone()));
        bytes
    };
    Ok((
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Body::from(bytes),
    )
        .into_response())
}
fn capacity_error() -> ApiError {
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({"error":"telemetry response capacity exceeded"}),
    )
}

#[expect(
    clippy::too_many_lines,
    reason = "One snapshot lists the existing telemetry contract and its persisted joins together"
)]
async fn build(state: &HttpState) -> Result<TelemetryResponse, ApiError> {
    let db = &state.store;
    let (
        mut blocks,
        self_address,
        indexer,
        chain_head,
        babe_epoch,
        babe_authorities,
        mut chain_miners,
        mut recent_difficulty,
        hardware,
        authorship,
        node_descriptors,
        mineable_topologies,
    ) = tokio::try_join!(
        db.get_recent_blocks(500, 0),
        db.get_self_address(),
        db.get_indexer_observability(),
        db.get_chain_head(),
        db.get_current_babe_epoch(),
        db.get_active_babe_authorities(),
        db.get_chain_miners(),
        db.get_recent_difficulty(50),
        db.get_all_miner_hardware(),
        db.get_validator_authorship(),
        db.get_all_node_descriptors(),
        db.get_mineable_topologies(),
    )?;
    let self_address = self_address.or_else(|| state.operator_account.clone());
    let (recent_mining_submissions, self_problems_attempted) = if let Some(account) = &self_address
    {
        tokio::try_join!(
            db.get_recent_mining_submissions(account, 20),
            db.count_mining_submissions_with_attempts(account)
        )?
    } else {
        (Vec::new(), 0)
    };
    let hardware: BTreeMap<_, _> = hardware
        .into_iter()
        .map(|row| (row.account_id.clone(), row))
        .collect();
    for miner in &mut chain_miners {
        miner.hardware = hardware.get(&miner.account_id).cloned();
        miner.telemetry_node_address = miner.hardware.as_ref().map(|row| row.node_id.clone());
    }
    // A configured or historical identity alone does not authorize attaching
    // current local hardware or dispatch to that account after a failed poll.
    let current_dispatch = if indexer.as_ref().and_then(|row| row.self_identified) != Some(false)
        && self_address
            .as_ref()
            .and_then(|account| hardware.get(account))
            .is_some_and(|row| !row.miners.is_empty())
    {
        if let Some(number) = chain_head
            .as_ref()
            .and_then(|head| head.qblock_count)
            .and_then(|number| number.checked_add(1))
            .and_then(|number| i64::try_from(number).ok())
        {
            serde_json::from_value(best_effort(state.miner.local_dispatch(number).await)?)?
        } else {
            None
        }
    } else {
        None
    };
    let now = (state.clock)();
    let validators = babe_authorities
        .iter()
        .map(|authority| {
            let stats = authorship
                .iter()
                .find(|row| row.account_id == authority.account_id);
            let last_authored_at = stats.and_then(|row| row.last_authored_at.clone());
            let online = last_authored_at
                .as_deref()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .is_some_and(|time| now.signed_duration_since(time).num_milliseconds() < 180_000);
            ValidatorAuthorshipRecord {
                account_id: authority.account_id.clone(),
                blocks_authored: stats.map_or(0, |row| row.blocks_authored),
                blocks_authored_with_pow: stats.map_or(0, |row| row.blocks_authored_with_pow),
                last_authored_block: stats.and_then(|row| row.last_authored_block.clone()),
                last_authored_at,
                online,
            }
        })
        .collect();
    let mut nodes = BTreeMap::new();
    let mut updated_at = String::new();
    for record in &node_descriptors {
        let descriptor = &record.descriptor;
        let location = if let Some(host) = &descriptor.public_host {
            state.geo.lookup(host).await
        } else {
            None
        };
        let node = NodeInfo {
            address: record.account_id.clone(),
            status: "active".into(),
            first_seen: record.first_block_timestamp,
            last_seen: record.block_timestamp,
            last_heartbeat: None,
            ecdsa_public_key_hex: None,
            node_name: Some(descriptor.node_name.clone()),
            public_host: descriptor.public_host.clone(),
            public_port: descriptor.public_port,
            log_level: descriptor.log_level.clone(),
            runtime: descriptor.runtime.clone(),
            miners: descriptor.miners.clone(),
            system_info: descriptor.system_info.clone(),
            location,
        };
        let _ = nodes.insert(record.account_id.clone(), node);
        if record.observed_at > updated_at {
            updated_at.clone_from(&record.observed_at);
        }
    }
    let count = u32::try_from(nodes.len()).map_err(|_| capacity_error())?;
    let nodes = if nodes.is_empty() {
        None
    } else {
        Some(NodesSnapshot {
            updated_at,
            node_count: count,
            active_count: count,
            nodes,
        })
    };
    if let Some(topology) = mineable_topologies
        .iter()
        .find(|row| row.is_default)
        .map(|row| &row.topology_hash)
    {
        blocks.retain(|row| row.topology_hash.as_ref() == Some(topology));
        recent_difficulty.retain(|row| row.topology_hash.as_ref() == Some(topology));
    }
    Ok(TelemetryResponse {
        blocks,
        self_address,
        indexer,
        server_time: state.now(),
        chain_head,
        babe_epoch,
        babe_authorities,
        chain_miners,
        recent_difficulty,
        mineable_topologies,
        validators,
        nodes,
        node_descriptors,
        recent_mining_submissions,
        self_problems_attempted,
        current_dispatch,
        files: TelemetryFiles {
            qblocks_manifest: "/files/qblocks/metadata.json".to_owned(),
        },
    })
}
