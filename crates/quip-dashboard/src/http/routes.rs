// SPDX-License-Identifier: AGPL-3.0-or-later
use super::HttpState;
use crate::miner::parse::MinerError;
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use dashboard_store::StoreError;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;

type ApiResult = Result<Response, ApiError>;
pub(super) struct ApiError(pub(super) StatusCode, pub(super) Value);
impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        if matches!(error, StoreError::Capacity) {
            return super::response::capacity();
        }
        tracing::error!(%error, "API store read failed");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error":"internal server error"}),
        )
    }
}
impl From<serde_json::Error> for ApiError {
    fn from(error: serde_json::Error) -> Self {
        tracing::error!(%error, "API serialization failed");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error":"internal server error"}),
        )
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}
#[derive(Serialize)]
struct Blocks {
    blocks: Vec<dashboard_model::BlockRecord>,
}
pub(super) async fn blocks(
    State(state): State<HttpState>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult {
    let limit = page_number(query.get("limit"), 100, 1, 500);
    let offset = page_number(query.get("offset"), 0, 0, i64::MAX as u64);
    let body = Blocks {
        blocks: state
            .store
            .get_recent_blocks(u32::try_from(limit).unwrap_or(100), offset)
            .await?,
    };
    super::response::json(&state, &body)
}
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    reason = "JavaScript Number paging truncates finite doubles after clamping to nonnegative bounds"
)]
fn page_number(value: Option<&String>, default: u64, min: u64, max: u64) -> u64 {
    let Some(raw) = value else {
        return default;
    };
    let number = if raw.trim().is_empty() {
        0.0
    } else {
        raw.parse::<f64>().unwrap_or(f64::NAN)
    };
    if number.is_finite() {
        number.trunc().clamp(min as f64, max as f64) as u64
    } else {
        default
    }
}
pub(super) async fn miner_wins(State(state): State<HttpState>) -> ApiResult {
    let body = dashboard_model::MinerWinsResponse {
        rows: state.store.get_miner_wins().await?,
    };
    super::response::json(&state, &body)
}
fn since(query: &HashMap<String, String>) -> Result<(&str, String), ApiError> {
    let parsed = query.get("since").and_then(|raw| {
        let time = chrono::DateTime::parse_from_rfc3339(raw)
            .map(|time| time.with_timezone(&chrono::Utc))
            .ok()
            .or_else(|| {
                chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d")
                    .ok()
                    .and_then(|date| date.and_hms_opt(0, 0, 0))
                    .map(|time| time.and_utc())
            });
        time.map(|time| {
            (
                raw.as_str(),
                time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            )
        })
    });
    parsed.ok_or_else(|| {
        ApiError(
            StatusCode::BAD_REQUEST,
            json!({"error":"query parameter `since` must be an ISO 8601 timestamp"}),
        )
    })
}
pub(super) async fn mining_history(
    State(state): State<HttpState>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult {
    let (since, canonical) = since(&query)?;
    let body = dashboard_model::MiningHistoryResponse {
        since: since.into(),
        rows: state.store.get_mining_history_since(&canonical).await?,
    };
    super::response::json(&state, &body)
}
pub(super) async fn difficulty_history(
    State(state): State<HttpState>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult {
    let (since, canonical) = since(&query)?;
    let (rows, anchor) = tokio::try_join!(
        state.store.get_difficulty_since(&canonical),
        state.store.get_difficulty_anchor_before(&canonical)
    )?;
    let body = dashboard_model::DifficultyHistoryResponse {
        since: since.into(),
        anchor,
        rows,
    };
    super::response::json(&state, &body)
}
pub(super) async fn health(State(state): State<HttpState>) -> Response {
    let snapshot = state.health.snapshot();
    (
        if snapshot.ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(snapshot),
    )
        .into_response()
}
pub(super) async fn live(State(state): State<HttpState>) -> Response {
    let mut snapshot = state.health.snapshot();
    snapshot.ok = snapshot.live;
    (
        if snapshot.live {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(snapshot),
    )
        .into_response()
}
fn positive_integer(raw: &str) -> Option<u64> {
    let value = raw.parse::<f64>().ok()?;
    if !value.is_finite() || value <= 0.0 || value.fract() != 0.0 || value > 9_007_199_254_740_991.0
    {
        return None;
    }
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "Positive safe integer bounds checked above"
    )]
    Some(value as u64)
}
pub(super) async fn attempts(
    State(state): State<HttpState>,
    Path(solution): Path<String>,
) -> ApiResult {
    let solution = positive_integer(&solution).ok_or_else(|| {
        ApiError(
            StatusCode::BAD_REQUEST,
            json!({"error":"invalid solution_number"}),
        )
    })?;
    let observation = state
        .miner
        .local_attempts(solution)
        .await
        .map_err(miner_error)?;
    let mut value = observation.data.clone();
    value.submission.observed_at = state.now();
    super::response::json(&state, &value)
}
fn miner_error(error: MinerError) -> ApiError {
    let (status, body) = match error {
        MinerError::NotFound(_) => (StatusCode::NOT_FOUND, json!({"error":"not found"})),
        MinerError::MissingLocalUrl => (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error":"miner REST endpoint not resolvable yet"}),
        ),
        MinerError::Unparsable(detail) => (
            StatusCode::BAD_GATEWAY,
            json!({"error":"upstream parse failed","detail":format!("mining-attempts: {detail}")}),
        ),
        MinerError::Unreachable(detail) | MinerError::Http(detail) => (
            StatusCode::BAD_GATEWAY,
            json!({"error":"upstream unreachable","detail":detail}),
        ),
        MinerError::EnvelopeFailure(error) => (StatusCode::BAD_GATEWAY, json!({"error":error})),
        MinerError::UpstreamStatus(status) => (
            StatusCode::BAD_GATEWAY,
            json!({"error":format!("upstream {status}")}),
        ),
        MinerError::RateLimited => (StatusCode::BAD_GATEWAY, json!({"error":"upstream 429"})),
        MinerError::BodyTooLarge { cap } => (
            StatusCode::BAD_GATEWAY,
            json!({"error":"upstream parse failed","detail":format!("response exceeded {cap} bytes")}),
        ),
        MinerError::InvalidSolutionNumber => (
            StatusCode::BAD_REQUEST,
            json!({"error":"invalid solution_number"}),
        ),
    };
    ApiError(status, body)
}
pub(super) async fn node_live(
    State(state): State<HttpState>,
    Path(account): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult {
    let snapshot = state.miner.peer_snapshot(&account).await;
    let reachable = snapshot.stats.is_ok() || snapshot.status.is_ok();
    let modes = snapshot
        .status
        .as_ref()
        .map_or_else(|_| json!({}), |status| json!(status.data.modes));
    let miner_stats = snapshot
        .stats
        .as_ref()
        .map_or(Value::Null, |stats| json!(stats.data));
    let problem = query
        .get("problem")
        .and_then(|raw| positive_integer(raw))
        .and_then(|number| i64::try_from(number).ok());
    let current_dispatch = if snapshot.status.is_ok() {
        if let Some(problem) = problem {
            best_effort(state.miner.peer_dispatch(&account, problem).await)?
        } else {
            Value::Null
        }
    } else {
        Value::Null
    };
    super::response::json(
        &state,
        &json!({"accountId":account,"reachable":reachable,"minerStats":miner_stats,"modes":modes,"currentDispatch":current_dispatch,"fetchedAt":state.now()}),
    )
}
pub(super) fn best_effort<T: Serialize>(
    result: Result<std::sync::Arc<crate::miner::Observed<T>>, MinerError>,
) -> Result<Value, ApiError> {
    match result {
        Ok(value) => Ok(serde_json::to_value(&value.data)?),
        Err(error) => {
            tracing::debug!(%error,"optional miner observation unavailable");
            Ok(Value::Null)
        }
    }
}
