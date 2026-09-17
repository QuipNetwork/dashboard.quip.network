// SPDX-License-Identifier: AGPL-3.0-or-later
//! Faithful parsers for miner REST `/api/v1/status`, `/api/v1/stats`, and
//! `/api/v1/mining/attempts`. Field names and defaults match the shared
//! telemetry contract (`packages/shared/telemetry/miner.ts`).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

/// IEEE-754 safe integer magnitude used by miner-api rule N1.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// `MAX_SAFE_INTEGER` (2^53 - 1) as `f64`, exactly representable, for the
/// JSON float range check without an integer-to-float cast.
const MAX_SAFE_INTEGER_F64: f64 = 9_007_199_254_740_991.0;

/// Hardware category reported on miner handles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum MinerCategory {
    /// CPU backend.
    Cpu,
    /// GPU backend.
    Gpu,
    /// QPU backend.
    Qpu,
    /// Unknown or prefix look-alike.
    Other,
}

impl MinerCategory {
    /// Category name used on the wire (`CPU` / `GPU` / `QPU` / `OTHER`).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Cpu => "CPU",
            Self::Gpu => "GPU",
            Self::Qpu => "QPU",
            Self::Other => "OTHER",
        }
    }
}

/// One worker handle from `/api/v1/status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MinerHandle {
    /// Miner process id.
    pub id: String,
    /// Narrowed hardware category.
    #[serde(rename = "type")]
    pub miner_type: MinerCategory,
}

/// On-chain miner registration block from `/api/v1/status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinerInfo {
    /// Registration block number.
    pub registered_at: i64,
    /// Deposit as a decimal string (u128).
    pub deposit: String,
    /// Proofs submitted as a decimal string (u64).
    pub proofs_submitted: String,
    /// Proofs won as a decimal string.
    pub proofs_won: String,
    /// Rewards earned as a decimal string (u128).
    pub rewards_earned: String,
}

/// Parsed `/api/v1/status` body (`NodeStatus` in the indexer client).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeStatus {
    /// SS58 address.
    pub ss58_address: String,
    /// Account id hex.
    pub account_id_hex: String,
    /// Node id string.
    pub node_id: String,
    /// Whether the miner reports it is mining.
    pub is_mining: bool,
    /// Process uptime in seconds.
    pub uptime_seconds: i64,
    /// Chain head hash from the nested `chain` object.
    pub chain_head_hash: String,
    /// Chain head number from the nested `chain` object.
    pub chain_head_number: i64,
    /// Whether the miner reports on-chain registration.
    pub miner_registered: bool,
    /// Registration details, or `null` when omitted.
    pub miner_info: Option<MinerInfo>,
    /// Declared miners.
    pub miners: Vec<MinerHandle>,
    /// Per-mode breakdown; empty for legacy single-process miners.
    #[serde(default)]
    pub modes: HashMap<String, ModeBreakdown>,
}

/// Aggregate counters from `/api/v1/stats` `controller`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinerStats {
    /// Heads observed.
    pub heads_observed: i64,
    /// Contexts dispatched.
    pub contexts_dispatched: i64,
    /// Results received.
    pub results_received: i64,
    /// Proofs submitted.
    pub proofs_submitted: i64,
    /// Stale drops.
    pub stale_drops: i64,
    /// Submission errors.
    pub submission_errors: i64,
    /// Duplicate result drops.
    pub duplicate_result_drops: i64,
}

/// Per-backend slice of an aggregated `/api/v1/status` snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeBreakdown {
    /// Heads observed in this mode.
    pub heads_observed: i64,
    /// Contexts dispatched in this mode.
    pub contexts_dispatched: i64,
    /// Results received in this mode.
    pub results_received: i64,
    /// Proofs submitted in this mode.
    pub proofs_submitted: i64,
    /// Stale drops in this mode.
    pub stale_drops: i64,
    /// Submission errors in this mode.
    pub submission_errors: i64,
    /// Duplicate result drops in this mode.
    pub duplicate_result_drops: i64,
    /// Workers owned by this mode.
    pub miners: Vec<MinerHandle>,
}

/// Per-iteration row inside a mining submission.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiningAttempt {
    /// Iteration index.
    pub iter: i64,
    /// Best energy in milli-units.
    pub best_energy_milli: i64,
    /// Open-enum result kind from the miner.
    pub result_kind: String,
    /// Backend that produced this iteration.
    pub miner_type: String,
    /// Remaining miner fields, excluding hoisted keys.
    pub extra: Map<String, Value>,
}

/// Per-submission summary from `/api/v1/mining/attempts?solution_number=N`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiningSubmissionRecord {
    /// Global chain solution number.
    pub solution_number: i64,
    /// Miner id.
    pub miner_id: String,
    /// Backend type, empty when the miner omits it.
    pub miner_type: String,
    /// Submission wall-clock nanoseconds as a decimal string.
    pub ts_ns: String,
    /// Energy in milli-units.
    pub energy_milli: i64,
    /// Diversity in milli-units.
    pub diversity_milli: i64,
    /// Decayed difficulty targeted at submit time.
    pub threshold_milli: i64,
    /// Last proof block hash.
    pub last_proof_block_hash: String,
    /// Extrinsic hash, if landed.
    pub extrinsic_hash: Option<String>,
    /// Chain block hash, if landed.
    pub chain_block_hash: Option<String>,
    /// Chain block number as a decimal string, if landed.
    pub chain_block_number: Option<String>,
    /// On-chain `proofs_submitted` sequence for non-winners.
    pub pow_sequence: Option<i64>,
    /// Outcome string preserved verbatim.
    pub outcome: String,
    /// Derived attempt count.
    pub attempt_count: i64,
    /// Derived minimum `bestEnergyMilli`.
    pub best_energy_milli: i64,
    /// Solutions count (submission-level `num_valid` or fallback).
    pub num_valid: i64,
    /// Sum of per-iteration `qpu_access_time_us`.
    pub qpu_access_time_us: i64,
    /// ISO-8601 stamp filled by the caller, empty from the parser.
    pub observed_at: String,
}

/// Envelope returned after parsing a `solution_number` lookup.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MiningAttemptsResponse {
    /// Submission summary.
    pub submission: MiningSubmissionRecord,
    /// Iteration trail.
    pub attempts: Vec<MiningAttempt>,
}

/// In-flight or just-completed dispatch trail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DispatchStatus {
    /// Current global problem is being ground.
    InFlight,
    /// Previous problem still has iterations and the current one is empty.
    Completed,
}

/// Active dispatch payload used by telemetry and peer live.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentDispatch {
    /// Global solution number for this trail.
    pub solution_number: i64,
    /// Iteration rows.
    pub attempts: Vec<MiningAttempt>,
    /// Whether the trail is current or just completed.
    pub status: DispatchStatus,
}

/// Advertised peer REST host taken from a persisted descriptor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerHost {
    /// `publicHost` from the descriptor, possibly including a scheme.
    pub public_host: Option<String>,
    /// `publicPort` from the descriptor.
    pub public_port: Option<u16>,
}

/// Parse and protocol errors. HTTP maps these onto existing status codes.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum MinerError {
    /// Miner returned 404 for a `solution_number` lookup.
    #[error("mining submission {0} not found")]
    NotFound(u64),
    /// Miner returned 429.
    #[error("rate limited")]
    RateLimited,
    /// Body cannot become a row (missing field or out-of-range number).
    #[error("mining-attempts: {0}")]
    Unparsable(String),
    /// Non-success HTTP status other than 404/429.
    #[error("upstream {0}")]
    UpstreamStatus(u16),
    /// Transport, DNS, timeout, or connect failure.
    #[error("upstream unreachable: {0}")]
    Unreachable(String),
    /// Envelope `success: false`.
    #[error("upstream reported failure: {0}")]
    EnvelopeFailure(String),
    /// Local REST base URL was empty.
    #[error("miner REST endpoint not resolvable yet")]
    MissingLocalUrl,
    /// Response exceeded the configured byte cap.
    #[error("response exceeded {cap} bytes")]
    BodyTooLarge {
        /// Configured cap.
        cap: usize,
    },
    /// HTTP client construction or request build failed.
    #[error("http client: {0}")]
    Http(String),
    /// Solution number was not a positive integer.
    #[error("invalid solution_number")]
    InvalidSolutionNumber,
}

/// Map a miner type string onto `CPU` / `GPU` / `QPU` / `OTHER`.
///
/// Matches `narrowMinerType` in `packages/core/api/miner-live.ts`: prefix
/// match on `^(CPU|GPU|QPU)\b`, case-insensitive.
#[must_use]
pub fn narrow_miner_type(raw: &Value) -> MinerCategory {
    let text = match raw {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    let upper = text.to_ascii_uppercase();
    if let Some(rest) = upper.strip_prefix("CPU")
        && (rest.is_empty() || !starts_with_ascii_alnum(rest))
    {
        return MinerCategory::Cpu;
    }
    if let Some(rest) = upper.strip_prefix("GPU")
        && (rest.is_empty() || !starts_with_ascii_alnum(rest))
    {
        return MinerCategory::Gpu;
    }
    if let Some(rest) = upper.strip_prefix("QPU")
        && (rest.is_empty() || !starts_with_ascii_alnum(rest))
    {
        return MinerCategory::Qpu;
    }
    MinerCategory::Other
}

fn starts_with_ascii_alnum(s: &str) -> bool {
    s.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
}

/// Decode `/api/v1/stats` `controller` counters into [`MinerStats`].
#[must_use]
pub fn parse_miner_stats_payload(raw: &Value) -> MinerStats {
    let controller = raw.get("controller").and_then(Value::as_object);
    MinerStats {
        heads_observed: controller_count(controller, "heads_observed"),
        contexts_dispatched: controller_count(controller, "contexts_dispatched"),
        results_received: controller_count(controller, "results_received"),
        proofs_submitted: controller_count(controller, "proofs_submitted"),
        stale_drops: controller_count(controller, "stale_drops"),
        submission_errors: controller_count(controller, "submission_errors"),
        duplicate_result_drops: controller_count(controller, "duplicate_result_drops"),
    }
}

fn controller_count(controller: Option<&Map<String, Value>>, key: &str) -> i64 {
    let Some(map) = controller else {
        return 0;
    };
    json_to_i64(map.get(key)).unwrap_or(0)
}

/// Decode the `modes` field from `/api/v1/status`.
#[must_use]
pub fn parse_status_modes(raw: Option<&Value>) -> HashMap<String, ModeBreakdown> {
    let Some(Value::Object(map)) = raw else {
        return HashMap::new();
    };
    let mut out = HashMap::new();
    for (mode, value) in map {
        let Value::Object(v) = value else {
            continue;
        };
        let ctrl = v.get("controller").and_then(Value::as_object);
        let miners = parse_miner_handles(v.get("miners"));
        let _inserted = out.insert(
            mode.clone(),
            ModeBreakdown {
                heads_observed: controller_count(ctrl, "heads_observed"),
                contexts_dispatched: controller_count(ctrl, "contexts_dispatched"),
                results_received: controller_count(ctrl, "results_received"),
                proofs_submitted: controller_count(ctrl, "proofs_submitted"),
                stale_drops: controller_count(ctrl, "stale_drops"),
                submission_errors: controller_count(ctrl, "submission_errors"),
                duplicate_result_drops: controller_count(ctrl, "duplicate_result_drops"),
                miners,
            },
        );
    }
    out
}

/// First miner id declared on `/api/v1/status`, or `None`.
#[must_use]
pub fn parse_status_primary_miner_id(raw: &Value) -> Option<String> {
    let miners = raw.get("miners")?.as_array()?;
    let first = miners.first()?.as_object()?;
    let id = json_to_string(first.get("id"), "");
    if id.is_empty() { None } else { Some(id) }
}

/// Decode a full `/api/v1/status` payload, after envelope unwrap.
#[must_use]
pub fn parse_node_status(raw: &Value) -> NodeStatus {
    let chain = raw.get("chain").and_then(Value::as_object);
    let miner_info = match raw.get("miner_info") {
        Some(Value::Object(m)) => Some(MinerInfo {
            registered_at: json_to_i64(m.get("registered_at")).unwrap_or(0),
            deposit: json_to_string(m.get("deposit"), "0"),
            proofs_submitted: json_to_string(m.get("proofs_submitted"), "0"),
            proofs_won: json_to_string(m.get("proofs_won"), "0"),
            rewards_earned: json_to_string(m.get("rewards_earned"), "0"),
        }),
        None | Some(_) => None,
    };
    NodeStatus {
        ss58_address: json_to_string(raw.get("ss58_address"), ""),
        account_id_hex: json_to_string(raw.get("account_id_hex"), ""),
        node_id: json_to_string(raw.get("node_id"), ""),
        is_mining: json_truthy(raw.get("is_mining")),
        uptime_seconds: json_to_i64(raw.get("uptime_seconds")).unwrap_or(0),
        chain_head_hash: chain
            .and_then(|c| c.get("head_hash"))
            .map(|v| json_to_string(Some(v), ""))
            .unwrap_or_default(),
        chain_head_number: chain
            .and_then(|c| json_to_i64(c.get("head_number")))
            .unwrap_or(0),
        miner_registered: json_truthy(raw.get("miner_registered")),
        miner_info,
        miners: parse_miner_handles(raw.get("miners")),
        modes: parse_status_modes(raw.get("modes")),
    }
}

fn parse_miner_handles(raw: Option<&Value>) -> Vec<MinerHandle> {
    let Some(Value::Array(items)) = raw else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let ty = obj.get("type").cloned().unwrap_or(Value::Null);
        out.push(MinerHandle {
            id: json_to_string(obj.get("id"), ""),
            miner_type: narrow_miner_type(&ty),
        });
    }
    out
}

/// Unwrap `{success, data, error}` envelopes used by miner REST.
///
/// # Errors
///
/// Returns [`MinerError::EnvelopeFailure`] when `success` is false.
pub fn unwrap_envelope(raw: Value) -> Result<Value, MinerError> {
    let Value::Object(ref obj) = raw else {
        return Ok(raw);
    };
    if obj.get("success").and_then(Value::as_bool) == Some(false) {
        let msg = json_to_string(obj.get("error"), "envelope reported failure");
        return Err(MinerError::EnvelopeFailure(msg));
    }
    if let Some(data) = obj.get("data") {
        return Ok(data.clone());
    }
    Ok(raw)
}

/// Parse `/api/v1/mining/attempts` submission envelope.
///
/// # Errors
///
/// Returns [`MinerError::Unparsable`] when required fields are missing or a
/// required number is outside the safe-integer range.
pub fn parse_mining_attempts_api_response(
    raw: &Value,
) -> Result<MiningAttemptsResponse, MinerError> {
    let Value::Object(env) = raw else {
        return Err(MinerError::Unparsable("response is not an object".into()));
    };
    let Some(Value::Object(s)) = env.get("submission") else {
        return Err(MinerError::Unparsable("missing `submission` field".into()));
    };
    let attempts = parse_attempts(env.get("attempts"));
    let energy_milli = require_num(s.get("energy_milli"), "energy_milli")?;
    let submission = MiningSubmissionRecord {
        solution_number: require_num(s.get("solution_number"), "solution_number")?,
        miner_id: require_str(s.get("miner_id"), "miner_id")?,
        miner_type: match s.get("miner_type") {
            Some(Value::String(v)) => v.clone(),
            _ => String::new(),
        },
        ts_ns: json_to_string(s.get("ts_ns"), "0"),
        energy_milli,
        diversity_milli: require_num(s.get("diversity_milli"), "diversity_milli")?,
        threshold_milli: require_num(s.get("threshold_milli"), "threshold_milli")?,
        last_proof_block_hash: require_str(
            s.get("last_proof_block_hash"),
            "last_proof_block_hash",
        )?,
        extrinsic_hash: optional_string(s.get("extrinsic_hash")),
        chain_block_hash: optional_string(s.get("chain_block_hash")),
        chain_block_number: match s.get("chain_block_number") {
            None | Some(Value::Null) => None,
            Some(v) => Some(json_to_string(Some(v), "")),
        },
        pow_sequence: optional_num(s.get("pow_sequence")),
        outcome: require_str(s.get("outcome"), "outcome")?,
        attempt_count: i64::try_from(attempts.len()).unwrap_or(i64::MAX),
        best_energy_milli: best_energy(&attempts, energy_milli),
        num_valid: extract_num_valid(s, &attempts, env.get("attempts")),
        qpu_access_time_us: sum_qpu_access_time_us(env.get("attempts")),
        observed_at: String::new(),
    };
    Ok(MiningAttemptsResponse {
        submission,
        attempts,
    })
}

/// Parse the `?miner_id=&solution_number=` dispatch form. Structural failure
/// yields an empty list, matching `parseDispatchAttemptsApiResponse`.
#[must_use]
pub fn parse_dispatch_attempts_api_response(raw: &Value) -> Vec<MiningAttempt> {
    let Some(obj) = raw.as_object() else {
        return Vec::new();
    };
    parse_attempts(obj.get("attempts"))
}

/// Build a [`CurrentDispatch`] from current and previous attempt lists.
#[must_use]
pub fn select_current_dispatch(
    current_solution_number: i64,
    current: Vec<MiningAttempt>,
    previous: Vec<MiningAttempt>,
) -> Option<CurrentDispatch> {
    if !current.is_empty() {
        return Some(CurrentDispatch {
            solution_number: current_solution_number,
            attempts: current,
            status: DispatchStatus::InFlight,
        });
    }
    if !previous.is_empty() {
        return Some(CurrentDispatch {
            solution_number: current_solution_number.saturating_sub(1),
            attempts: previous,
            status: DispatchStatus::Completed,
        });
    }
    None
}

/// Derive the peer miner-REST base URL from a persisted descriptor host.
///
/// Matches `resolvePeerMinerRestUrl` in `packages/core/api/resolve-miner-rest.ts`.
/// Returns `None` when the host is missing. Never accepts a caller-supplied URL.
#[must_use]
pub fn resolve_peer_miner_rest_url(host: Option<&PeerHost>) -> Option<String> {
    let host = host?;
    let advertised = host.public_host.as_ref()?.trim();
    if advertised.is_empty() {
        return None;
    }
    let port = host.public_port;
    let (scheme, without_scheme) = if let Some(rest) = advertised.strip_prefix("https://") {
        ("https", rest)
    } else if let Some(rest) = advertised.strip_prefix("http://") {
        ("http", rest)
    } else if advertised.len() >= 8 && advertised[..8].eq_ignore_ascii_case("https://") {
        ("https", &advertised[8..])
    } else if advertised.len() >= 7 && advertised[..7].eq_ignore_ascii_case("http://") {
        ("http", &advertised[7..])
    } else if port == Some(443) {
        ("https", advertised)
    } else {
        ("http", advertised)
    };
    let trimmed = without_scheme.trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    match port {
        Some(p) => Some(format!("{scheme}://{trimmed}:{p}")),
        None => Some(format!("{scheme}://{trimmed}")),
    }
}

fn extract_num_valid(
    submission: &Map<String, Value>,
    parsed: &[MiningAttempt],
    raw: Option<&Value>,
) -> i64 {
    if let Some(n) = optional_num(submission.get("num_valid")) {
        return n;
    }
    let Some(Value::Array(raw_attempts)) = raw else {
        return 0;
    };
    for r in raw_attempts.iter().rev() {
        let Some(obj) = r.as_object() else {
            continue;
        };
        let kind = obj
            .get("result_kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if !kind.contains("submit") {
            continue;
        }
        if let Some(n) = productivity_from_raw(obj) {
            return n;
        }
    }
    for a in parsed.iter().rev() {
        if let Some(n) = nested_number(&Value::Object(a.extra.clone()), "n_unique_total") {
            return n;
        }
        if let Some(n) = a
            .extra
            .get("num_valid")
            .and_then(|v| numeric_extra(Some(v)))
        {
            return n;
        }
        if let Some(meta) = a.extra.get("solution_meta")
            && let Some(n) = nested_number(meta, "n_unique_total")
        {
            return n;
        }
    }
    0
}

fn productivity_from_raw(r: &Map<String, Value>) -> Option<i64> {
    if let Some(n) = nested_number(
        r.get("solution_meta").unwrap_or(&Value::Null),
        "n_unique_total",
    ) {
        return Some(n);
    }
    numeric_extra(r.get("num_valid"))
}

fn nested_number(container: &Value, key: &str) -> Option<i64> {
    let Value::Object(map) = container else {
        return None;
    };
    numeric_extra(map.get(key))
}

fn sum_qpu_access_time_us(raw: Option<&Value>) -> i64 {
    let Some(Value::Array(items)) = raw else {
        return 0;
    };
    let mut total = 0_i64;
    for a in items {
        let Some(obj) = a.as_object() else {
            continue;
        };
        if let Some(v) = numeric_extra(obj.get("qpu_access_time_us"))
            && v > 0
        {
            total = total.saturating_add(v);
        }
    }
    total
}

fn parse_attempts(raw: Option<&Value>) -> Vec<MiningAttempt> {
    let Some(Value::Array(items)) = raw else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for a in items {
        let Some(obj) = a.as_object() else {
            continue;
        };
        let Some(iter_n) = safe_number(obj.get("iter")) else {
            continue;
        };
        let Some(best_n) = safe_number(obj.get("best_energy_milli")) else {
            continue;
        };
        let mut extra = Map::new();
        for (k, v) in obj {
            if k == "type"
                || k == "iter"
                || k == "best_energy_milli"
                || k == "result_kind"
                || k == "miner_type"
            {
                continue;
            }
            let _prev = extra.insert(k.clone(), v.clone());
        }
        out.push(MiningAttempt {
            iter: iter_n,
            best_energy_milli: best_n,
            result_kind: match obj.get("result_kind") {
                Some(Value::String(s)) => s.clone(),
                _ => String::new(),
            },
            miner_type: match obj.get("miner_type") {
                Some(Value::String(s)) => s.clone(),
                _ => String::new(),
            },
            extra,
        });
    }
    out
}

fn best_energy(attempts: &[MiningAttempt], fallback: i64) -> i64 {
    let Some(first) = attempts.first() else {
        return fallback;
    };
    let mut best = first.best_energy_milli;
    for a in attempts.iter().skip(1) {
        if a.best_energy_milli < best {
            best = a.best_energy_milli;
        }
    }
    best
}

fn require_str(v: Option<&Value>, name: &str) -> Result<String, MinerError> {
    match v {
        Some(Value::String(s)) if !s.is_empty() => Ok(s.clone()),
        _ => Err(MinerError::Unparsable(format!(
            "missing string field `{name}`"
        ))),
    }
}

fn require_num(v: Option<&Value>, name: &str) -> Result<i64, MinerError> {
    match safe_number(v) {
        Some(n) => Ok(n),
        None => Err(MinerError::Unparsable(format!(
            "missing or out-of-range numeric field `{name}` (got {})",
            display_raw(v)
        ))),
    }
}

fn display_raw(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(other) => other.to_string(),
    }
}

fn optional_string(v: Option<&Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(json_to_string(Some(other), "")),
    }
}

fn optional_num(v: Option<&Value>) -> Option<i64> {
    match v {
        None | Some(Value::Null) => None,
        Some(_) => numeric_extra(v),
    }
}

fn numeric_extra(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Number(_) | Value::String(_)) => safe_number(v),
        _ => None,
    }
}

fn safe_number(v: Option<&Value>) -> Option<i64> {
    let n = json_to_i64(v)?;
    if n.unsigned_abs() > MAX_SAFE_INTEGER.unsigned_abs() {
        return None;
    }
    Some(n)
}

fn json_to_i64(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Number(n)) => {
            if let Some(i) = n.as_i64() {
                return Some(i);
            }
            if let Some(u) = n.as_u64() {
                return i64::try_from(u).ok();
            }
            let f = n.as_f64()?;
            if !f.is_finite() {
                return None;
            }
            if f.abs() > MAX_SAFE_INTEGER_F64 {
                return None;
            }
            let truncated = f.trunc();
            // `f` was bounded to the safe-integer range above, so no integral
            // precision is lost by the truncating cast; only the fraction drops.
            #[expect(
                clippy::cast_possible_truncation,
                reason = "fraction-only truncation within the safe-integer bound"
            )]
            Some(truncated as i64)
        }
        Some(Value::String(s)) => parse_decimal_i64(s),
        Some(Value::Bool(true)) => Some(1),
        Some(Value::Bool(false)) => Some(0),
        None | Some(_) => None,
    }
}

fn parse_decimal_i64(s: &str) -> Option<i64> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed: i128 = trimmed.parse().ok()?;
    if parsed.abs() > i128::from(MAX_SAFE_INTEGER) {
        // Still return None for the safe-integer guard; callers that need
        // only finiteness treat None as unreported.
        if parsed.abs() > i128::from(i64::MAX) {
            return None;
        }
        return i64::try_from(parsed)
            .ok()
            .filter(|n| n.unsigned_abs() <= MAX_SAFE_INTEGER.unsigned_abs());
    }
    i64::try_from(parsed).ok()
}

fn json_to_string(v: Option<&Value>, default: &str) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        None | Some(_) => default.to_owned(),
    }
}

fn json_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => {
            if let Some(i) = n.as_i64() {
                i != 0
            } else if let Some(u) = n.as_u64() {
                u != 0
            } else {
                n.as_f64().is_some_and(|f| f != 0.0)
            }
        }
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(_)) => true,
    }
}

/// Format a Unix millisecond timestamp as UTC ISO-8601 with millisecond precision.
#[must_use]
pub fn format_iso8601_ms(unix_ms: u64) -> String {
    let secs = i64::try_from(unix_ms / 1000).unwrap_or(0);
    let millis = unix_ms % 1000;
    let days = secs.div_euclid(86_400);
    let tod = u64::try_from(secs.rem_euclid(86_400)).unwrap_or(0);
    let hour = tod / 3_600;
    let min = (tod % 3_600) / 60;
    let sec = tod % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{millis:03}Z")
}

/// Howard Hinnant `civil_from_days` for Unix day count (days since 1970-01-01).
fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = u32::try_from(z.rem_euclid(146_097)).unwrap_or(0);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = i32::try_from(i64::from(yoe) + era * 400).unwrap_or(1970);
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}
