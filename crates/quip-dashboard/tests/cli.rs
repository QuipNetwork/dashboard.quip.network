// SPDX-License-Identifier: AGPL-3.0-or-later
//! Operator commands use isolated files and a fake HTTP process.
#![expect(
    clippy::panic_in_result_fn,
    reason = "Integration tests assert behavior while propagating setup and IO errors"
)]
use std::{error::Error, process::Stdio};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    process::Command,
};
type TestResult = Result<(), Box<dyn Error>>;

fn command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_quip-dashboard"));
    let _ = command.env_clear().kill_on_drop(true).stdin(Stdio::null());
    command
}

#[tokio::test]
async fn help_lists_all_operator_commands() -> TestResult {
    let result = command().arg("--help").output().await?;
    assert!(result.status.success());
    let help = String::from_utf8(result.stdout)?;
    for name in [
        "serve",
        "migrate",
        "list-indexables",
        "reindex",
        "reconstruct-firstseen",
        "healthcheck",
    ] {
        assert!(help.contains(name), "missing {name}");
    }
    Ok(())
}

#[tokio::test]
async fn healthcheck_uses_live_route_without_opening_database() -> TestResult {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let server = async {
        let (mut stream, _) = listener.accept().await?;
        let mut request = [0; 2048];
        let bytes = stream.read(&mut request).await?;
        let text = std::str::from_utf8(request.get(..bytes).ok_or("invalid request size")?)?;
        assert!(text.starts_with("GET /api/live HTTP/1.1\r\n"));
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
            )
            .await?;
        Ok::<(), Box<dyn Error>>(())
    };
    let process = command()
        .env("DATABASE_URL", "this-is-invalid-and-must-not-be-read")
        .args(["healthcheck", "--url", &url])
        .output();
    let (server, result) = tokio::join!(server, process);
    server?;
    assert!(result?.status.success());
    Ok(())
}

#[tokio::test]
async fn unknown_reindex_domain_is_rejected_before_opening_database() -> TestResult {
    let result = command()
        .args(["reindex", "not-an-indexable"])
        .output()
        .await?;
    assert!(!result.status.success());
    assert!(String::from_utf8(result.stderr)?.contains("invalid value"));
    Ok(())
}

#[tokio::test]
async fn migrations_are_offline_and_second_writer_is_rejected() -> TestResult {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("dashboard.db");
    let result = command()
        .env("QUIP_EMBEDDED_DB_PATH", &path)
        .env("QUIP_VALIDATOR_RPC_URLS", "ws://127.0.0.1:1")
        .arg("migrate")
        .output()
        .await?;
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let store =
        dashboard_store::Store::open(dashboard_store::StoreConfig::Turso { path: path.clone() })
            .await?;
    let result = command()
        .env("QUIP_EMBEDDED_DB_PATH", &path)
        .arg("migrate")
        .output()
        .await?;
    assert!(!result.status.success());
    assert!(String::from_utf8(result.stderr)?.contains("writer"));
    drop(store);
    Ok(())
}

#[tokio::test]
async fn migration_dry_run_does_not_create_a_database() -> TestResult {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("absent.db");
    let result = command()
        .env("QUIP_EMBEDDED_DB_PATH", &path)
        .args(["migrate", "dry-run"])
        .output()
        .await?;
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8(result.stdout)?.contains("0001_initial"));
    assert!(!path.exists());
    Ok(())
}

#[tokio::test]
async fn serve_stays_live_during_validator_outage_and_sigterm_releases_writer() -> TestResult {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("service.db");
    let reserved = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = reserved.local_addr()?.port();
    drop(reserved);
    // Retain a TCP endpoint that never answers the WebSocket handshake.
    let unavailable = TcpListener::bind("127.0.0.1:0").await?;
    let rpc = format!("ws://{}", unavailable.local_addr()?);
    let mut process = command()
        .env("QUIP_EMBEDDED_DB_PATH", &path)
        .env("QUIP_VALIDATOR_RPC_URLS", rpc)
        .env(
            "QUIP_MINER_REST_URL",
            format!("http://{}", unavailable.local_addr()?),
        )
        .env("PORT", port.to_string())
        .arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(1))
        .build()?;
    let url = format!("http://127.0.0.1:{port}");
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if let Ok(response) = client.get(format!("{url}/api/live")).send().await
                && response.status() == reqwest::StatusCode::OK
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await?;
    assert_eq!(
        client
            .get(format!("{url}/api/health"))
            .send()
            .await?
            .status(),
        reqwest::StatusCode::SERVICE_UNAVAILABLE
    );
    let pid = process.id().ok_or("service process missing")?;
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(i32::try_from(pid)?),
        nix::sys::signal::Signal::SIGTERM,
    )?;
    let status = tokio::time::timeout(std::time::Duration::from_secs(20), process.wait()).await??;
    assert!(status.success());
    let store = dashboard_store::Store::open(dashboard_store::StoreConfig::Turso { path }).await?;
    store.close().await?;
    Ok(())
}
