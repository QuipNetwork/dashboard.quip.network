// SPDX-License-Identifier: AGPL-3.0-or-later
//! Environment configuration with explicit database and upstream selection.
use std::{collections::BTreeMap, fmt, path::PathBuf};

/// A URL whose debug representation never reveals credentials.
#[derive(Clone)]
pub struct UrlValue(String);
impl UrlValue {
    /// Borrow the URL only at its connection boundary.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl fmt::Debug for UrlValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}
/// Explicit storage selection. An invalid URL never falls back to local storage.
#[derive(Clone, Debug)]
pub enum DatabaseBackend {
    /// Embedded local database.
    Turso {
        /// Database file path.
        path: PathBuf,
    },
    /// Postgres server database.
    Postgres {
        /// Redacted connection URL.
        url: UrlValue,
        /// Reader pool limit.
        max_connections: u32,
    },
}
/// Validated environment configuration.
#[derive(Clone, Debug)]
pub struct Config {
    /// Explicit local or server database.
    pub database: DatabaseBackend,
    /// Enable the local chain and miner workers.
    pub run_indexer: bool,
    /// Internal HTTP port.
    pub listen_port: u16,
    /// Ordered direct validator endpoints.
    pub validator_rpc_urls: Vec<UrlValue>,
    /// Independent direct miner HTTP endpoint.
    pub miner_rest_url: UrlValue,
    /// Optional operator account for API projections.
    pub operator_account: Option<String>,
    /// Optional local `GeoIP` database file.
    pub geoip_db_path: Option<PathBuf>,
    /// Enforced resource limits and intervals.
    pub limits: Limits,
}
/// Fixed backend budgets with a configurable miner polling interval.
#[derive(Clone, Debug)]
pub struct Limits {
    /// Maximum admitted block work.
    pub admitted_block_work: u64,
    /// Reserved live admission slots.
    pub live_reserved: u64,
    /// Live decode workers.
    pub live_decodes: u64,
    /// Backfill decode workers.
    pub backfill_decodes: u64,
    /// Backfill blocks admitted each second.
    pub backfill_blocks_per_sec: u64,
    /// Backfill block concurrency.
    pub backfill_concurrency: u64,
    /// Shared RPC slots.
    pub rpc_in_flight: u64,
    /// Backfill RPC slots.
    pub rpc_backfill_slots: u64,
    /// Maximum RPC response size.
    pub rpc_response_max_bytes: u64,
    /// Maximum miner response size.
    pub miner_response_max_bytes: u64,
    /// Shared cache budget.
    pub cache_storage_bytes: u64,
    /// Concurrent peer probes.
    pub peer_probes: u64,
    /// Seconds between local miner polls, at least eight.
    pub miner_poll_interval_sec: u64,
    /// Peer success cache age.
    pub peer_cache_ttl_sec: u64,
    /// Peer failure cache age.
    pub peer_failure_ttl_sec: u64,
    /// RPC request timeout.
    pub rpc_timeout_ms: u64,
    /// Indexer reconnect backoff cap.
    pub reconnect_max_backoff_ms: u64,
    /// Whole-backend shutdown budget.
    pub shutdown_deadline_sec: u64,
    /// Stalled progress readiness limit.
    pub stale_progress_sec: u64,
    /// Local startup time limit.
    pub startup_deadline_sec: u64,
}
/// Configuration failures name the key without revealing its value.
#[derive(Debug, thiserror::Error)]
#[error("{key}: {reason}")]
pub struct ConfigError {
    key: &'static str,
    reason: &'static str,
}
impl Config {
    /// Read process configuration. No secret resolution happens here.
    ///
    /// # Errors
    /// Returns malformed or unsupported configuration.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_pairs(std::env::vars())
    }
    /// Parse an injected environment for deterministic tests and launchers.
    ///
    /// # Errors
    /// Returns malformed or unsupported configuration.
    pub fn from_pairs<K: Into<String>, V: Into<String>>(
        pairs: impl IntoIterator<Item = (K, V)>,
    ) -> Result<Self, ConfigError> {
        let vars: BTreeMap<String, String> = pairs
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect();
        let get = |key: &str| {
            vars.get(key)
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        };
        let database = database(
            get("DATABASE_URL"),
            get("DATABASE_POOL_MAX"),
            get("QUIP_EMBEDDED_DB_PATH"),
        )?;
        let run_indexer = match get("RUN_INDEXER")
            .unwrap_or("true")
            .to_ascii_lowercase()
            .as_str()
        {
            "true" | "1" => true,
            "false" | "0" => false,
            _ => return Err(error("RUN_INDEXER", "expected true, false, 1, or 0")),
        };
        if !run_indexer && let DatabaseBackend::Turso { .. } = database {
            return Err(error("RUN_INDEXER", "API-only mode requires PostgreSQL"));
        }
        let validator_rpc_urls = get("QUIP_VALIDATOR_RPC_URLS")
            .unwrap_or("ws://quip-validator:9944")
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|value| {
                validated_url(
                    value.trim_end_matches('/'),
                    "QUIP_VALIDATOR_RPC_URLS",
                    &["ws", "wss"],
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        if validator_rpc_urls.is_empty() {
            return Err(error(
                "QUIP_VALIDATOR_RPC_URLS",
                "at least one endpoint is required",
            ));
        }
        let miner_rest_url = validated_url(
            get("QUIP_MINER_REST_URL")
                .unwrap_or("http://quip-miner:8086")
                .trim_end_matches('/'),
            "QUIP_MINER_REST_URL",
            &["http", "https"],
        )?;
        let listen_port = number(get("PORT"), "PORT", 3001, 1, 65_535)?;
        let poll = number(get("POLL_INTERVAL_SEC"), "POLL_INTERVAL_SEC", 8, 8, 60)?;
        for (key, value) in [
            ("QUIP_VALIDATOR_BACKFILL_BLOCKS_PER_SEC", 1),
            ("QUIP_VALIDATOR_BACKFILL_CONCURRENCY", 1),
            ("QUIP_VALIDATOR_RPC_TIMEOUT_MS", 15_000),
            ("QUIP_VALIDATOR_RECONNECT_MAX_BACKOFF_MS", 30_000),
        ] {
            let _ = number(get(key), key, value, value, value)?;
        }
        for key in [
            "QUIP_VALIDATOR_BABE_POLL_SEC",
            "QUIP_VALIDATOR_CHAIN_POLL_SEC",
            "NODES_REFRESH_SEC",
            "STALL_WARN_AFTER_SEC",
        ] {
            if get(key).is_some() {
                return Err(error(
                    key,
                    "removed setting: reconciliation follows finalized heads and health uses progress",
                ));
            }
        }
        let operator_account = get("QUIP_OPERATOR_ACCOUNT").map(str::to_owned);
        if let Some(account) = &operator_account
            && (!(46..=50).contains(&account.len())
                || !account.bytes().all(|b| {
                    b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".contains(&b)
                }))
        {
            return Err(error(
                "QUIP_OPERATOR_ACCOUNT",
                "expected an SS58 account with 46 to 50 base58 characters",
            ));
        }
        Ok(Self {
            database,
            run_indexer,
            listen_port: u16::try_from(listen_port).map_err(|_| error("PORT", "invalid port"))?,
            validator_rpc_urls,
            miner_rest_url,
            operator_account,
            geoip_db_path: get("GEOIP_DB_PATH").map(PathBuf::from),
            limits: Limits::new(poll),
        })
    }
    /// Whether this process provides the API without local indexing workers.
    #[must_use]
    pub const fn is_api_only(&self) -> bool {
        !self.run_indexer
    }
}
fn error(key: &'static str, reason: &'static str) -> ConfigError {
    ConfigError { key, reason }
}
fn validated_url(raw: &str, key: &'static str, schemes: &[&str]) -> Result<UrlValue, ConfigError> {
    let parsed = url::Url::parse(raw).map_err(|_| error(key, "invalid URL"))?;
    if !schemes.contains(&parsed.scheme()) || parsed.host_str().is_none() {
        return Err(error(key, "unsupported URL scheme or missing host"));
    }
    Ok(UrlValue(raw.into()))
}
fn number(
    raw: Option<&str>,
    key: &'static str,
    default: u64,
    min: u64,
    max: u64,
) -> Result<u64, ConfigError> {
    let value = raw
        .map(str::parse::<u64>)
        .transpose()
        .map_err(|_| error(key, "expected an unsigned integer"))?
        .unwrap_or(default);
    if !(min..=max).contains(&value) {
        return Err(error(key, "value exceeds the supported limits"));
    }
    Ok(value)
}

fn database(
    raw: Option<&str>,
    pool: Option<&str>,
    path: Option<&str>,
) -> Result<DatabaseBackend, ConfigError> {
    Ok(if let Some(value) = raw {
        let url = validated_url(value, "DATABASE_URL", &["postgres", "postgresql"])?;
        let max_connections = pool
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(10);
        if max_connections > 64 {
            return Err(error("DATABASE_POOL_MAX", "must be at most 64"));
        }
        DatabaseBackend::Postgres {
            url,
            max_connections,
        }
    } else {
        DatabaseBackend::Turso {
            path: PathBuf::from(path.unwrap_or("/data/dashboard.db")),
        }
    })
}
impl Limits {
    fn new(poll: u64) -> Self {
        Self {
            admitted_block_work: 64,
            live_reserved: 8,
            live_decodes: 1,
            backfill_decodes: 1,
            backfill_blocks_per_sec: 1,
            backfill_concurrency: 1,
            rpc_in_flight: 4,
            rpc_backfill_slots: 2,
            rpc_response_max_bytes: 16 * 1024 * 1024,
            miner_response_max_bytes: 4 * 1024 * 1024,
            cache_storage_bytes: 32 * 1024 * 1024,
            peer_probes: 2,
            miner_poll_interval_sec: poll,
            peer_cache_ttl_sec: 5,
            peer_failure_ttl_sec: 60,
            rpc_timeout_ms: 15_000,
            reconnect_max_backoff_ms: 30_000,
            shutdown_deadline_sec: 20,
            stale_progress_sec: 90,
            startup_deadline_sec: 60,
        }
    }
}
