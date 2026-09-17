//! Entry point for the combined dashboard process supervisor.

use std::{
    io::{self, Write},
    net::SocketAddr,
    path::PathBuf,
    process::ExitCode,
    sync::Arc,
    time::Duration,
};

use clap::Parser;
use quip_dashboard::supervisor::{Config, LogCounters, run};

#[derive(Parser)]
#[command(about = "Supervise the dashboard backend, Caddy, and log collector")]
struct Args {
    #[arg(long)]
    collector_program: Option<PathBuf>,
    #[arg(long)]
    backend_program: Option<PathBuf>,
    #[arg(long)]
    caddy_program: Option<PathBuf>,
    #[arg(long)]
    syslog_address: Option<SocketAddr>,
    #[arg(long, default_value_t = 20_000, value_parser = clap::value_parser!(u64).range(1..=20_000))]
    shutdown_timeout_ms: u64,
    #[arg(long, default_value_t = 128, value_parser = clap::value_parser!(u16).range(1..=1024))]
    log_capacity: u16,
}

// An unavailable stderr must never keep the supervisor alive. This final
// diagnostic uses a separate descriptor so it also cannot block on the log
// writer's stderr lock. O_NONBLOCK is confined to this new open description.
fn diagnostic(message: &str) {
    use std::os::unix::fs::OpenOptionsExt;
    if let Ok(mut stderr) = std::fs::OpenOptions::new()
        .write(true)
        .custom_flags(nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
        .open("/proc/self/fd/2")
    {
        let _ = stderr.write_all(message.as_bytes());
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = Args::parse();
    let mut config = Config {
        shutdown_timeout: Duration::from_millis(args.shutdown_timeout_ms),
        log_capacity: usize::from(args.log_capacity),
        ..Config::default()
    };
    if let Some(path) = args.collector_program {
        config.collector.program = path;
    }
    if let Some(path) = args.backend_program {
        config.backend.program = path;
    }
    if let Some(path) = args.caddy_program {
        config.caddy.program = path;
    }
    if let Some(address) = args.syslog_address {
        config.syslog_address = address;
    }
    match run(config, Arc::new(LogCounters::default())).await {
        Ok(report) => {
            diagnostic(&format!(
                "supervisor: reason={:?} timed_out={} oversized_lines={} stderr_dropped_lines={} stderr_pending_lines={} udp_dropped_lines={} read_errors={}\n",
                report.reason,
                report.timed_out,
                report.logs.oversized_lines,
                report.logs.stderr_dropped_lines,
                report.logs.stderr_pending_lines,
                report.logs.udp_dropped_lines,
                report.logs.read_errors
            ));
            ExitCode::from(report.exit_code())
        }
        Err(error) => {
            diagnostic(&format!("supervisor: {error}\n"));
            ExitCode::from(if error.kind() == io::ErrorKind::InvalidInput {
                2
            } else {
                71
            })
        }
    }
}
