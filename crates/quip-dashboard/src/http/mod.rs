// SPDX-License-Identifier: AGPL-3.0-or-later
//! Read-only dashboard API backed by persisted chain data and shared miner probes.
mod admission;
pub mod geo;
mod response;
mod routes;
mod telemetry;

use crate::{health::HealthState, miner::MinerService};
use axum::{
    Router,
    http::{HeaderValue, Method, header},
    middleware,
    routing::get,
};
use chrono::{DateTime, Utc};
use dashboard_store::Store;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Shared dependencies for the public read-only API.
#[derive(Clone)]
pub struct HttpState {
    store: Arc<Store>,
    miner: Arc<MinerService>,
    health: HealthState,
    operator_account: Option<String>,
    clock: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
    cache: Arc<Mutex<telemetry::SnapshotCache>>,
    response_budget: Arc<tokio::sync::Semaphore>,
    miner_dispatch: bool,
}

impl HttpState {
    /// Assemble the API from the process-owned services.
    #[must_use]
    pub fn new(store: Arc<Store>, miner: Arc<MinerService>, health: HealthState) -> Self {
        Self {
            store,
            miner,
            health,
            operator_account: None,
            clock: Arc::new(Utc::now),
            cache: Arc::new(Mutex::new(telemetry::SnapshotCache::default())),
            response_budget: Arc::new(tokio::sync::Semaphore::new(response::BYTES)),
            miner_dispatch: true,
        }
    }
    /// Declare whether a miner poller runs in this process. False in API-only
    /// mode, where nothing writes the dispatch document the client would read.
    #[must_use]
    pub const fn with_miner_dispatch(mut self, miner_dispatch: bool) -> Self {
        self.miner_dispatch = miner_dispatch;
        self
    }
    /// Set the operator identity used before a local status observation is available.
    #[must_use]
    pub fn with_operator_account(mut self, account: Option<String>) -> Self {
        self.operator_account = account;
        self
    }
    /// Supply a deterministic clock for contract replay.
    #[must_use]
    pub fn with_clock(mut self, clock: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>) -> Self {
        self.clock = clock;
        self
    }
    fn now(&self) -> String {
        (self.clock)().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }
}

/// Build the eight data routes and independent health endpoints.
///
/// Three admission pools, not one. The health endpoints keep their own so
/// liveness and readiness stay answerable while the data routes are saturated.
/// Peer proxying keeps its own because it waits on a third party.
pub fn router(state: HttpState) -> Router {
    let slots = Arc::new(tokio::sync::Semaphore::new(8));
    let health_slots = Arc::new(tokio::sync::Semaphore::new(2));
    // Proxying reaches a third party, so its latency is not ours. A permit is
    // held for the whole handler, including time queued on the miner client's
    // own limits, so sharing the data pool let a few slow descriptors starve
    // every unrelated route. Its own pool bounds the harm to this route.
    let proxy_slots = Arc::new(tokio::sync::Semaphore::new(4));
    Router::new()
        .route("/api/telemetry", get(telemetry::get))
        .route("/api/blocks", get(routes::blocks))
        .route("/api/miner-wins", get(routes::miner_wins))
        .route("/api/mining-history", get(routes::mining_history))
        .route("/api/difficulty-history", get(routes::difficulty_history))
        .route("/api/node/{account}/live", get(routes::node_live))
        .route("/api/node/{account}/summary", get(routes::node_summary))
        .route("/api/mining/attempts/{solution}", get(routes::attempts))
        .route("/api/health", get(routes::health))
        .route("/api/live", get(routes::live))
        .with_state(state)
        .layer(middleware::from_fn(
            move |request: axum::extract::Request, next| {
                let path = request.uri().path();
                let admission_slots = if matches!(path, "/api/live" | "/api/health") {
                    Arc::clone(&health_slots)
                } else if path.starts_with("/api/node/") && path.ends_with("/live") {
                    // Matched by shape: the account segment varies.
                    Arc::clone(&proxy_slots)
                } else {
                    Arc::clone(&slots)
                };
                admission::run(request, next, admission_slots)
            },
        ))
        .layer(middleware::from_fn(
            |request: axum::extract::Request, next: middleware::Next| async move {
                let mut response = if request.method() == Method::OPTIONS {
                    axum::http::StatusCode::NO_CONTENT.into_response()
                } else {
                    next.run(request).await
                };
                let headers = response.headers_mut();
                let _ = headers.insert(
                    header::ACCESS_CONTROL_ALLOW_ORIGIN,
                    HeaderValue::from_static("*"),
                );
                let _ = headers.insert(
                    header::ACCESS_CONTROL_ALLOW_METHODS,
                    HeaderValue::from_static("GET, HEAD, OPTIONS"),
                );
                response
            },
        ))
}
use axum::response::IntoResponse;
