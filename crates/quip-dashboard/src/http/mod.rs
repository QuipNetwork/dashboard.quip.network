// SPDX-License-Identifier: AGPL-3.0-or-later
//! Read-only dashboard API backed by persisted chain data and shared miner probes.
mod admission;
mod geo;
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
use std::{path::PathBuf, sync::Arc};
use tokio::sync::Mutex;

/// Shared dependencies for the public read-only API.
#[derive(Clone)]
pub struct HttpState {
    store: Arc<Store>,
    miner: Arc<MinerService>,
    health: HealthState,
    operator_account: Option<String>,
    geo: Arc<geo::GeoIp>,
    clock: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
    cache: Arc<Mutex<telemetry::SnapshotCache>>,
    response_budget: Arc<tokio::sync::Semaphore>,
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
            geo: Arc::new(geo::GeoIp::new(None)),
            clock: Arc::new(Utc::now),
            cache: Arc::new(Mutex::new(telemetry::SnapshotCache::default())),
            response_budget: Arc::new(tokio::sync::Semaphore::new(response::BYTES)),
        }
    }
    /// Set the operator identity used before a local status observation is available.
    #[must_use]
    pub fn with_operator_account(mut self, account: Option<String>) -> Self {
        self.operator_account = account;
        self
    }
    /// Enable optional offline city lookup from a local `MaxMind` database.
    #[must_use]
    #[expect(
        clippy::needless_pass_by_value,
        reason = "The consuming builder accepts the owned optional configuration path"
    )]
    pub fn with_geoip_path(mut self, path: Option<PathBuf>) -> Self {
        self.geo = Arc::new(geo::GeoIp::new(path.as_deref()));
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

/// Build the seven data routes and independent health endpoints.
pub fn router(state: HttpState) -> Router {
    let slots = Arc::new(tokio::sync::Semaphore::new(8));
    let health_slots = Arc::new(tokio::sync::Semaphore::new(2));
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
                let admission_slots = if matches!(request.uri().path(), "/api/live" | "/api/health")
                {
                    Arc::clone(&health_slots)
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
