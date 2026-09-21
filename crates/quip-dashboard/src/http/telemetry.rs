// SPDX-License-Identifier: AGPL-3.0-or-later
use super::{HttpState, routes::ApiError};
use axum::{
    body::{Body, Bytes},
    extract::State,
    http::header,
    response::{IntoResponse, Response},
};
use dashboard_model::{TelemetryFiles, TelemetryResponse, ValidatorAuthorshipRecord};
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
async fn build(state: &HttpState) -> Result<TelemetryResponse, ApiError> {
    let db = &state.store;
    let (
        self_address,
        indexer,
        chain_head,
        babe_epoch,
        babe_authorities,
        mut chain_miners,
        mut recent_difficulty,
        hardware,
        authorship,
        mineable_topologies,
    ) = tokio::try_join!(
        db.get_self_address(),
        db.get_indexer_observability(),
        db.get_chain_head(),
        db.get_current_babe_epoch(),
        db.get_active_babe_authorities(),
        db.get_chain_miners(),
        db.get_recent_difficulty(50),
        db.get_all_miner_hardware(),
        db.get_validator_authorship(),
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
    if let Some(topology) = mineable_topologies
        .iter()
        .find(|row| row.is_default)
        .map(|row| &row.topology_hash)
    {
        recent_difficulty.retain(|row| row.topology_hash.as_ref() == Some(topology));
    }
    let miner_current_dispatch = miner_dispatch_url(self_address.as_deref());
    Ok(TelemetryResponse {
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
        recent_mining_submissions,
        self_problems_attempted,
        files: TelemetryFiles {
            qblocks_manifest: "/files/qblocks/metadata.json".to_owned(),
            nodes_snapshot: "/files/nodes/snapshot.json".to_owned(),
            miner_current_dispatch,
        },
        capabilities: dashboard_model::Capabilities {
            miner_dispatch: state.miner_dispatch,
        },
    })
}

/// Static URL of `account`'s dispatch document, or `None` without an account.
fn miner_dispatch_url(account: Option<&str>) -> Option<String> {
    account.map(|account| format!("/files/miners/{account}/current-dispatch.json"))
}

#[cfg(test)]
mod tests {
    use super::miner_dispatch_url;

    /// The pointer names the account's file, and is absent without an account.
    #[test]
    fn the_dispatch_pointer_follows_the_miner_file_layout() {
        assert_eq!(
            miner_dispatch_url(Some("5G8Ack")).as_deref(),
            Some("/files/miners/5G8Ack/current-dispatch.json")
        );
        assert_eq!(miner_dispatch_url(None), None);
    }
}
