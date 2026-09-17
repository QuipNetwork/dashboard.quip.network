// SPDX-License-Identifier: AGPL-3.0-or-later

//! Configuration validation for `quip-dashboard`.
//!
//! Tests inject environment pairs without changing the process environment.
#![expect(
    clippy::panic_in_result_fn,
    reason = "test assertions report mismatches while Result propagates fixture setup failures"
)]

use quip_dashboard::config;

use std::error::Error;
use std::path::Path;

use config::{Config, ConfigError, DatabaseBackend};

type TestResult = Result<(), Box<dyn Error>>;

fn parse(pairs: &[(&str, &str)]) -> Result<Config, ConfigError> {
    Config::from_pairs(pairs.iter().copied())
}

fn parse_ok(pairs: &[(&str, &str)]) -> Result<Config, Box<dyn Error>> {
    parse(pairs).map_err(Into::into)
}

fn parse_err(pairs: &[(&str, &str)]) -> Result<ConfigError, Box<dyn Error>> {
    match parse(pairs) {
        Err(err) => Ok(err),
        Ok(_) => Err("expected config error".into()),
    }
}

fn postgres_url(backend: &DatabaseBackend) -> Result<&str, Box<dyn Error>> {
    match backend {
        DatabaseBackend::Postgres { url, .. } => Ok(url.as_str()),
        DatabaseBackend::Turso { .. } => Err("expected Postgres backend".into()),
    }
}

fn turso_path(backend: &DatabaseBackend) -> Result<&Path, Box<dyn Error>> {
    match backend {
        DatabaseBackend::Turso { path } => Ok(path.as_path()),
        DatabaseBackend::Postgres { .. } => Err("expected Turso backend".into()),
    }
}

#[test]
fn absent_database_url_selects_turso_default_path() -> TestResult {
    let cfg = parse_ok(&[])?;
    assert_eq!(turso_path(&cfg.database)?, Path::new("/data/dashboard.db"));
    assert!(cfg.run_indexer);
    assert!(!cfg.is_api_only());
    Ok(())
}

#[test]
fn empty_database_url_selects_turso() -> TestResult {
    let cfg = parse_ok(&[("DATABASE_URL", "   ")])?;
    assert_eq!(turso_path(&cfg.database)?, Path::new("/data/dashboard.db"));
    Ok(())
}

#[test]
fn embedded_path_is_configurable_when_url_absent() -> TestResult {
    let cfg = parse_ok(&[("QUIP_EMBEDDED_DB_PATH", "/var/lib/quip/dashboard.db")])?;
    assert_eq!(
        turso_path(&cfg.database)?,
        Path::new("/var/lib/quip/dashboard.db")
    );
    Ok(())
}

#[test]
fn postgres_and_postgresql_urls_select_postgres() -> TestResult {
    for raw in [
        "postgres://u:p@h:5432/db",
        "postgresql://quip:quip@postgres:5432/quip",
    ] {
        let cfg = parse_ok(&[("DATABASE_URL", raw)])?;
        assert_eq!(postgres_url(&cfg.database)?, raw);
        let DatabaseBackend::Postgres {
            max_connections, ..
        } = cfg.database
        else {
            return Err("expected Postgres backend".into());
        };
        assert_eq!(max_connections, 10);
    }
    Ok(())
}

#[test]
fn malformed_database_url_is_startup_error_without_turso_fallback() -> TestResult {
    let err = parse_err(&[("DATABASE_URL", "not-a-url")])?;
    let msg = err.to_string();
    assert!(msg.contains("DATABASE_URL"));
    assert!(!msg.contains("not-a-url"));
    Ok(())
}

#[test]
fn unsupported_database_url_scheme_is_startup_error() -> TestResult {
    for raw in [
        "mysql://u:p@h:3306/db",
        "http://postgres:5432/db",
        "sqlite:///tmp/db",
        "file:///data/dashboard.db",
        "postgresql://",
    ] {
        let err = parse_err(&[("DATABASE_URL", raw)])?;
        let msg = err.to_string();
        assert!(
            msg.contains("DATABASE_URL"),
            "missing DATABASE_URL in {msg}"
        );
        assert!(!msg.contains(raw), "leaked URL in {msg}");
    }
    Ok(())
}

#[test]
fn passwords_are_absent_from_errors_and_debug() -> TestResult {
    let secret = "s3cret-pass";
    let raw = format!("postgres://quip:{secret}@db.internal:5432/quip");
    let err = parse_err(&[("DATABASE_URL", "postgres://quip:s3cret-pass@")])?;
    let err_text = format!("{err:?}{err}");
    assert!(!err_text.contains(secret));

    let cfg = parse_ok(&[("DATABASE_URL", raw.as_str())])?;
    let debug = format!("{cfg:?}");
    assert!(!debug.contains(secret));
    assert!(debug.contains("***"));
    assert_eq!(postgres_url(&cfg.database)?, raw.as_str());
    Ok(())
}

#[test]
fn api_only_requires_postgres_and_rejects_turso() -> TestResult {
    let err = parse_err(&[("RUN_INDEXER", "false")])?;
    assert!(err.to_string().contains("RUN_INDEXER"));
    assert!(err.to_string().contains("PostgreSQL"));

    let cfg = parse_ok(&[
        ("DATABASE_URL", "postgres://u:p@h:5432/db"),
        ("RUN_INDEXER", "false"),
    ])?;
    assert!(cfg.is_api_only());
    assert!(!cfg.run_indexer);
    let _ = postgres_url(&cfg.database)?;
    Ok(())
}

#[test]
fn run_indexer_false_and_zero_are_api_only() -> TestResult {
    for flag in ["false", "FALSE", "0"] {
        let cfg = parse_ok(&[
            ("DATABASE_URL", "postgres://u:p@h:5432/db"),
            ("RUN_INDEXER", flag),
        ])?;
        assert!(cfg.is_api_only(), "flag {flag}");
    }
    Ok(())
}

#[test]
fn validator_rpc_defaults_and_parses_like_typescript() -> TestResult {
    let cfg = parse_ok(&[])?;
    assert_eq!(cfg.validator_rpc_urls.len(), 1);
    assert_eq!(
        cfg.validator_rpc_urls.first().map(config::UrlValue::as_str),
        Some("ws://quip-validator:9944")
    );

    let cfg = parse_ok(&[(
        "QUIP_VALIDATOR_RPC_URLS",
        "ws://primary:9944 , wss://secondary.example/rpc, ws://fallback:9944",
    )])?;
    let urls: Vec<&str> = cfg
        .validator_rpc_urls
        .iter()
        .map(config::UrlValue::as_str)
        .collect();
    assert_eq!(
        urls,
        [
            "ws://primary:9944",
            "wss://secondary.example/rpc",
            "ws://fallback:9944"
        ]
    );

    let cfg = parse_ok(&[(
        "QUIP_VALIDATOR_RPC_URLS",
        "wss://example.com/rpc/,ws://other:9944/",
    )])?;
    let urls: Vec<&str> = cfg
        .validator_rpc_urls
        .iter()
        .map(config::UrlValue::as_str)
        .collect();
    assert_eq!(urls, ["wss://example.com/rpc", "ws://other:9944"]);

    let cfg = parse_ok(&[("QUIP_VALIDATOR_RPC_URLS", ",ws://valid:9944,,")])?;
    assert_eq!(
        cfg.validator_rpc_urls.first().map(config::UrlValue::as_str),
        Some("ws://valid:9944")
    );

    let cfg = parse_ok(&[("QUIP_VALIDATOR_RPC_URLS", "   ")])?;
    assert_eq!(
        cfg.validator_rpc_urls.first().map(config::UrlValue::as_str),
        Some("ws://quip-validator:9944")
    );
    Ok(())
}

#[test]
fn validator_rpc_rejects_unusable_or_non_websocket_entries() -> TestResult {
    let err = parse_err(&[("QUIP_VALIDATOR_RPC_URLS", ",,,")])?;
    assert!(err.to_string().contains("QUIP_VALIDATOR_RPC_URLS"));

    let err = parse_err(&[("QUIP_VALIDATOR_RPC_URLS", "http://quip-validator:9944")])?;
    assert!(err.to_string().contains("QUIP_VALIDATOR_RPC_URLS"));
    assert!(!err.to_string().contains("http://quip-validator:9944"));
    Ok(())
}

#[test]
fn miner_rest_url_is_independent_of_validator_rpc() -> TestResult {
    let cfg = parse_ok(&[])?;
    assert_eq!(cfg.miner_rest_url.as_str(), "http://quip-miner:8086");

    let cfg = parse_ok(&[
        ("QUIP_VALIDATOR_RPC_URLS", "ws://quip-caddy:8088/rpc"),
        ("QUIP_MINER_REST_URL", "http://quip-miner:8086"),
    ])?;
    assert_eq!(
        cfg.validator_rpc_urls.first().map(config::UrlValue::as_str),
        Some("ws://quip-caddy:8088/rpc")
    );
    assert_eq!(cfg.miner_rest_url.as_str(), "http://quip-miner:8086");
    assert_ne!(
        cfg.miner_rest_url.as_str(),
        "http://quip-caddy:8088",
        "must not derive miner REST from the validator RPC URL"
    );
    Ok(())
}

#[test]
fn miner_rest_url_rejects_non_http() -> TestResult {
    let err = parse_err(&[("QUIP_MINER_REST_URL", "ws://quip-miner:8086")])?;
    assert!(err.to_string().contains("QUIP_MINER_REST_URL"));
    assert!(!err.to_string().contains("ws://quip-miner:8086"));
    Ok(())
}

#[test]
fn conservative_plan_limits_are_the_defaults() -> TestResult {
    let cfg = parse_ok(&[])?;
    let limits = &cfg.limits;
    assert_eq!(limits.admitted_block_work, 64);
    assert_eq!(limits.live_reserved, 8);
    assert_eq!(limits.live_decodes, 1);
    assert_eq!(limits.backfill_decodes, 1);
    assert_eq!(limits.backfill_blocks_per_sec, 1);
    assert_eq!(limits.backfill_concurrency, 1);
    assert_eq!(limits.rpc_in_flight, 4);
    assert_eq!(limits.rpc_backfill_slots, 2);
    assert_eq!(limits.rpc_response_max_bytes, 16 * 1024 * 1024);
    assert_eq!(limits.miner_response_max_bytes, 4 * 1024 * 1024);
    assert_eq!(limits.cache_storage_bytes, 32 * 1024 * 1024);
    assert_eq!(limits.peer_probes, 2);
    assert_eq!(limits.miner_poll_interval_sec, 8);
    assert_eq!(limits.peer_cache_ttl_sec, 5);
    assert_eq!(limits.peer_failure_ttl_sec, 60);
    assert_eq!(limits.rpc_timeout_ms, 15_000);
    assert_eq!(limits.reconnect_max_backoff_ms, 30_000);
    assert_eq!(limits.shutdown_deadline_sec, 20);
    assert_eq!(limits.stale_progress_sec, 90);
    assert_eq!(limits.startup_deadline_sec, 60);
    assert_eq!(cfg.listen_port, 3001);
    Ok(())
}

#[test]
fn unsupported_resource_overrides_fail_instead_of_being_ignored() -> TestResult {
    for (key, value) in [
        ("QUIP_VALIDATOR_BACKFILL_BLOCKS_PER_SEC", "3"),
        ("QUIP_VALIDATOR_BACKFILL_CONCURRENCY", "2"),
        ("QUIP_VALIDATOR_RPC_TIMEOUT_MS", "20000"),
        ("QUIP_VALIDATOR_RECONNECT_MAX_BACKOFF_MS", "120000"),
        ("NODES_REFRESH_SEC", "45"),
    ] {
        assert!(parse_err(&[(key, value)])?.to_string().contains(key));
    }
    Ok(())
}

#[test]
fn poll_interval_faster_than_eight_seconds_is_rejected() -> TestResult {
    let err = parse_err(&[("POLL_INTERVAL_SEC", "4")])?;
    assert!(err.to_string().contains("POLL_INTERVAL_SEC"));
    Ok(())
}

#[test]
fn backfill_limits_reject_values_above_the_conservative_cap() -> TestResult {
    let err = parse_err(&[("QUIP_VALIDATOR_BACKFILL_BLOCKS_PER_SEC", "6")])?;
    assert!(
        err.to_string()
            .contains("QUIP_VALIDATOR_BACKFILL_BLOCKS_PER_SEC")
    );
    let err = parse_err(&[("QUIP_VALIDATOR_BACKFILL_CONCURRENCY", "5")])?;
    assert!(
        err.to_string()
            .contains("QUIP_VALIDATOR_BACKFILL_CONCURRENCY")
    );
    Ok(())
}

#[test]
fn malformed_pool_max_falls_back_to_default() -> TestResult {
    let cfg = parse_ok(&[
        ("DATABASE_URL", "postgres://u:p@h:5432/db"),
        ("DATABASE_POOL_MAX", "abc"),
    ])?;
    let DatabaseBackend::Postgres {
        max_connections, ..
    } = cfg.database
    else {
        return Err("expected Postgres backend".into());
    };
    assert_eq!(max_connections, 10);
    Ok(())
}

#[test]
fn operator_account_preserves_ss58_rules() -> TestResult {
    let cfg = parse_ok(&[])?;
    assert_eq!(cfg.operator_account, None);

    let addr = "5HY4e5KJiAu5xhjqQn1bhymmDEvz8EfivCETPW7PkJso7qBe";
    let cfg = parse_ok(&[("QUIP_OPERATOR_ACCOUNT", addr)])?;
    assert_eq!(cfg.operator_account.as_deref(), Some(addr));

    let err = parse_err(&[("QUIP_OPERATOR_ACCOUNT", "not-a-real-ss58")])?;
    assert!(err.to_string().contains("QUIP_OPERATOR_ACCOUNT"));
    Ok(())
}

#[test]
fn geoip_path_is_optional() -> TestResult {
    let cfg = parse_ok(&[])?;
    assert_eq!(cfg.geoip_db_path, None);
    let cfg = parse_ok(&[("GEOIP_DB_PATH", "/opt/GeoLite2-City.mmdb")])?;
    assert_eq!(
        cfg.geoip_db_path.as_deref(),
        Some(Path::new("/opt/GeoLite2-City.mmdb"))
    );
    Ok(())
}
