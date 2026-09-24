//! Linux child supervision for the combined dashboard container.
//!
//! Tini must be PID 1 to reap orphaned descendants. Children must remain in the
//! process group assigned at spawn (the packaged programs do not daemonize).
//! Collector startup is ordered, but UDP delivery is best effort, including
//! startup and restarts. A successful UDP send does not establish readiness.

use std::{
    ffi::OsString,
    io::{self, Write},
    net::{SocketAddr, UdpSocket},
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};

use nix::{
    errno::Errno,
    sys::{
        signal::{Signal, killpg},
        wait::{Id, WaitPidFlag, WaitStatus, waitid},
    },
    unistd::Pid,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    signal::unix::{Signal as SignalStream, SignalKind, signal},
    sync::{Notify, oneshot},
    task::JoinHandle,
    time::{Instant, timeout_at},
};

const MAX_LINE: usize = 64 * 1024;
const MAX_DATAGRAM: usize = 65_507;

/// Linux refuses `execve` on a file another process still holds open for
/// writing, and reports `ETXTBSY`. The window is short and clears itself: a
/// deploy rewriting a binary, or a sibling thread that forked between this
/// process opening a file and closing it. Retrying briefly turns a spurious
/// 126 into a normal start. A missing program is permanent and is not retried,
/// so it still fails at once and still maps to 127.
const SPAWN_BUSY_ATTEMPTS: u32 = 10;
const SPAWN_BUSY_BACKOFF: Duration = Duration::from_millis(20);

/// Executable and arguments for one of the three fixed child roles.
#[derive(Clone, Debug)]
pub struct ChildSpec {
    /// Executable path; PATH lookup is supported.
    pub program: PathBuf,
    /// Arguments passed without shell interpolation.
    pub args: Vec<OsString>,
}

/// Packaging defaults and bounded test overrides.
#[derive(Clone, Debug)]
pub struct Config {
    /// Collector rotation shell. Its syslog-ng child must run in the foreground.
    pub collector: ChildSpec,
    /// Backend which migrates the database before admitting API requests.
    pub backend: ChildSpec,
    /// Caddy in foreground mode.
    pub caddy: ChildSpec,
    /// Internal collector address. UDP loss is unavoidable and not acknowledged.
    pub syslog_address: SocketAddr,
    /// Maximum total shutdown duration, at most 20 seconds.
    pub shutdown_timeout: Duration,
    /// Bounded stderr forwarding slots, from 1 through 1024.
    pub log_capacity: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            collector: ChildSpec {
                program: "/app/deploy/syslog-ng/rotate.sh".into(),
                args: vec![],
            },
            backend: ChildSpec {
                program: "quip-dashboard".into(),
                args: vec!["serve".into()],
            },
            caddy: ChildSpec {
                program: "caddy".into(),
                args: vec![
                    "run".into(),
                    "--config".into(),
                    "/etc/caddy/Caddyfile".into(),
                    "--adapter".into(),
                    "caddyfile".into(),
                ],
            },
            syslog_address: SocketAddr::from(([127, 0, 0, 1], 5514)),
            shutdown_timeout: Duration::from_secs(20),
            log_capacity: 128,
        }
    }
}

/// Counters updated directly by producers, including when the queue is full.
#[derive(Debug, Default)]
pub struct LogCounters {
    oversized_lines: AtomicU64,
    stderr_dropped_lines: AtomicU64,
    stderr_pending_lines: AtomicU64,
    udp_dropped_lines: AtomicU64,
    read_errors: AtomicU64,
}

/// Observable loss and undrained stderr work at the end of supervision.
#[derive(Clone, Copy, Debug, Default)]
pub struct LogStats {
    /// Lines above 64 KiB, discarded through their next newline or EOF.
    pub oversized_lines: u64,
    /// Lines rejected by the full stderr queue or a failed stderr write.
    pub stderr_dropped_lines: u64,
    /// Accepted stderr lines still queued or blocked in a write at the deadline.
    pub stderr_pending_lines: u64,
    /// Nonblocking UDP sends which failed, including oversized datagrams.
    /// This cannot count packets lost after a successful send.
    pub udp_dropped_lines: u64,
    /// Child pipe read failures.
    pub read_errors: u64,
}

impl LogCounters {
    /// Snapshot counters without relying on the forwarding queue.
    pub fn snapshot(&self) -> LogStats {
        LogStats {
            oversized_lines: self.oversized_lines.load(Ordering::Relaxed),
            stderr_dropped_lines: self.stderr_dropped_lines.load(Ordering::Relaxed),
            stderr_pending_lines: self.stderr_pending_lines.load(Ordering::Relaxed),
            udp_dropped_lines: self.udp_dropped_lines.load(Ordering::Relaxed),
            read_errors: self.read_errors.load(Ordering::Relaxed),
        }
    }
}

/// Child failure and operator shutdown remain distinguishable.
#[derive(Debug)]
pub enum ExitReason {
    /// SIGTERM or SIGINT initiated shutdown.
    Signal(Signal),
    /// Any unplanned backend or Caddy exit, including status zero.
    ChildExited {
        /// Backend or Caddy.
        role: &'static str,
        /// Observed status before reaping.
        status: WaitStatus,
    },
    /// The collector exited before being asked to stop.
    CollectorExited(WaitStatus),
    /// A configured program could not be started.
    SpawnFailed {
        /// Child whose executable failed to start.
        role: &'static str,
        /// Operating system error from spawning the executable.
        error: io::Error,
    },
    /// Signal registration, process ownership checks, or other supervision failed.
    Internal(io::Error),
}

/// Final status, also available to callers when stderr is blocked.
#[derive(Debug)]
pub struct Report {
    /// Why shutdown began.
    pub reason: ExitReason,
    /// A shutdown phase exceeded its budget, or child cleanup/log draining failed.
    pub timed_out: bool,
    /// Final observed log counters; pending work is abandoned on process exit.
    pub logs: LogStats,
}

impl Report {
    /// Zero for planned shutdown; failures, missing commands, and timeouts differ.
    #[must_use]
    pub fn exit_code(&self) -> u8 {
        match &self.reason {
            ExitReason::Signal(_) => {
                if self.timed_out {
                    124
                } else {
                    0
                }
            }
            ExitReason::ChildExited { .. } => 1,
            ExitReason::CollectorExited(_) => 70,
            ExitReason::SpawnFailed { error, .. } => {
                if error.kind() == io::ErrorKind::NotFound {
                    127
                } else {
                    126
                }
            }
            ExitReason::Internal(_) => 71,
        }
    }
}

struct OwnedChild {
    role: &'static str,
    child: Child,
    // Some only until the final group signal. Never call Child::wait/try_wait
    // while this is Some: the unreaped leader reserves this process-group ID.
    group: Option<Pid>,
    readers: Vec<JoinHandle<()>>,
}

impl OwnedChild {
    fn status(&self) -> io::Result<WaitStatus> {
        let group = self
            .group
            .ok_or_else(|| io::Error::other("child already released"))?;
        loop {
            match waitid(
                Id::Pid(group),
                WaitPidFlag::WEXITED | WaitPidFlag::WNOHANG | WaitPidFlag::WNOWAIT,
            ) {
                Err(Errno::EINTR) => {}
                result => return result.map_err(io::Error::from),
            }
        }
    }

    fn signal(&mut self, value: Signal) -> io::Result<()> {
        // Revalidate that our child is still waitable before signaling the group.
        // ECHILD means ownership was lost; do not use the cached numeric ID.
        if let Err(error) = self.status() {
            self.group = None;
            return Err(error);
        }
        if let Some(group) = self.group {
            match killpg(group, value) {
                Ok(()) | Err(Errno::ESRCH) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    async fn kill_and_reap(&mut self, deadline: Instant) -> io::Result<()> {
        let result = self.signal(Signal::SIGKILL);
        // No group signals are allowed after this point, including from Drop.
        self.group = None;
        let waited = timeout_at(deadline, self.child.wait())
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "child reap deadline"))?;
        result?;
        waited.map(|_| ())
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.group.is_some() {
            // Cancellation or early return still kills the owned group. Tokio's
            // orphan reaper handles the direct child after this guard is dropped.
            let _ = self.signal(Signal::SIGKILL);
        }
        for reader in &self.readers {
            reader.abort();
        }
    }
}

#[derive(Clone)]
struct Logs {
    sender: mpsc::SyncSender<Vec<u8>>,
    socket: Arc<UdpSocket>,
    address: SocketAddr,
    counters: Arc<LogCounters>,
    drained: Arc<Notify>,
}

impl Logs {
    fn start(
        config: &Config,
        counters: Arc<LogCounters>,
    ) -> io::Result<(Self, oneshot::Receiver<()>)> {
        let socket = UdpSocket::bind(if config.syslog_address.is_ipv4() {
            "0.0.0.0:0"
        } else {
            "[::]:0"
        })?;
        socket.set_nonblocking(true)?;
        let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(config.log_capacity);
        let (done, finished) = oneshot::channel();
        let writer_counters = Arc::clone(&counters);
        let drained = Arc::new(Notify::new());
        let writer_drained = Arc::clone(&drained);
        // A dedicated thread, never Tokio's blocking pool: a blocked container
        // stderr must not delay async work or runtime termination. Process exit
        // terminates this one thread if its bounded drain budget expires.
        let _ = std::thread::Builder::new()
            .name("supervisor-stderr".into())
            .spawn(move || {
                let mut stderr = io::stderr().lock();
                for line in receiver {
                    if stderr.write_all(&line).is_err() {
                        let _ = writer_counters
                            .stderr_dropped_lines
                            .fetch_add(1, Ordering::Relaxed);
                    }
                    let _ = writer_counters
                        .stderr_pending_lines
                        .fetch_sub(1, Ordering::Relaxed);
                    writer_drained.notify_one();
                }
                let _ = done.send(());
            })?;
        Ok((
            Self {
                sender,
                socket: Arc::new(socket),
                address: config.syslog_address,
                counters,
                drained,
            },
            finished,
        ))
    }

    async fn drain(&self, deadline: Instant) -> bool {
        loop {
            let changed = self.drained.notified();
            if self.counters.stderr_pending_lines.load(Ordering::Relaxed) == 0 {
                return false;
            }
            if timeout_at(deadline, changed).await.is_err() {
                return true;
            }
        }
    }

    fn line(&self, role: &'static str, line: &[u8]) {
        let tag = match role {
            "backend" => "quip-dashboard",
            "caddy" => "caddy",
            _ => "syslog-ng",
        };
        let mut message = Vec::with_capacity(line.len() + 32);
        message.extend_from_slice(b"<14>");
        message.extend_from_slice(tag.as_bytes());
        message.extend_from_slice(b": ");
        for &byte in line {
            message.push(if byte.is_ascii_control() && byte != b'\t' {
                b' '
            } else {
                byte
            });
        }
        if role != "collector"
            && (message.len() > MAX_DATAGRAM
                || self.socket.send_to(&message, self.address).is_err())
        {
            let _ = self
                .counters
                .udp_dropped_lines
                .fetch_add(1, Ordering::Relaxed);
        }
        message.push(b'\n');
        let _ = self
            .counters
            .stderr_pending_lines
            .fetch_add(1, Ordering::Relaxed);
        if self.sender.try_send(message).is_err() {
            let _ = self
                .counters
                .stderr_pending_lines
                .fetch_sub(1, Ordering::Relaxed);
            let _ = self
                .counters
                .stderr_dropped_lines
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    async fn read(&self, role: &'static str, mut pipe: impl AsyncRead + Unpin) {
        let mut bytes = [0_u8; 8192];
        let mut line = Vec::with_capacity(MAX_LINE);
        let mut oversized = false;
        loop {
            let count = match pipe.read(&mut bytes).await {
                Ok(0) => break,
                Ok(count) => count,
                Err(_) => {
                    let _ = self.counters.read_errors.fetch_add(1, Ordering::Relaxed);
                    break;
                }
            };
            for &byte in bytes.iter().take(count) {
                if byte == b'\n' {
                    if !oversized {
                        self.line(role, &line);
                    }
                    line.clear();
                    oversized = false;
                } else if !oversized {
                    if line.len() == MAX_LINE {
                        let _ = self
                            .counters
                            .oversized_lines
                            .fetch_add(1, Ordering::Relaxed);
                        line.clear();
                        oversized = true;
                    } else {
                        line.push(byte);
                    }
                }
            }
            // A producer with perpetually readable output cannot starve signals.
            tokio::task::yield_now().await;
        }
        if !oversized && !line.is_empty() {
            self.line(role, &line);
        }
    }
}

async fn spawn(role: &'static str, spec: &ChildSpec, logs: &Logs) -> io::Result<OwnedChild> {
    let mut attempt = 0_u32;
    let child = loop {
        match Command::new(&spec.program)
            .args(&spec.args)
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => break child,
            Err(error) => {
                attempt += 1;
                let busy = error.raw_os_error() == Some(nix::libc::ETXTBSY);
                if !busy || attempt >= SPAWN_BUSY_ATTEMPTS {
                    return Err(error);
                }
                tokio::time::sleep(SPAWN_BUSY_BACKOFF).await;
            }
        }
    };
    let pid = child
        .id()
        .ok_or_else(|| io::Error::other("spawned child has no pid"))?;
    let group = Pid::from_raw(i32::try_from(pid).map_err(io::Error::other)?);
    let mut owned = OwnedChild {
        role,
        child,
        group: Some(group),
        readers: vec![],
    };
    if let Some(pipe) = owned.child.stdout.take() {
        let logs = logs.clone();
        owned.readers.push(tokio::spawn(async move {
            logs.read(role, pipe).await;
        }));
    }
    if let Some(pipe) = owned.child.stderr.take() {
        let logs = logs.clone();
        owned.readers.push(tokio::spawn(async move {
            logs.read(role, pipe).await;
        }));
    }
    Ok(owned)
}

fn unexpected(children: &[OwnedChild]) -> Option<ExitReason> {
    for child in children {
        match child.status() {
            Ok(WaitStatus::StillAlive) => {}
            Ok(status) => {
                return Some(if child.role == "collector" {
                    ExitReason::CollectorExited(status)
                } else {
                    ExitReason::ChildExited {
                        role: child.role,
                        status,
                    }
                });
            }
            Err(error) => return Some(ExitReason::Internal(error)),
        }
    }
    None
}

async fn stop(
    children: &mut [OwnedChild],
    changes: &mut SignalStream,
    graceful: Instant,
    deadline: Instant,
) -> bool {
    let mut failed = false;
    for child in children.iter_mut() {
        if child.signal(Signal::SIGTERM).is_err() {
            failed = true;
        }
    }
    loop {
        let mut running = false;
        for child in children.iter() {
            match child.status() {
                Ok(WaitStatus::StillAlive) => running = true,
                Ok(_) => {}
                Err(_) => failed = true,
            }
        }
        if !running {
            break;
        }
        if timeout_at(graceful, changes.recv()).await.is_err() {
            failed = true;
            break;
        }
    }
    for child in children {
        if child.kill_and_reap(deadline).await.is_err() {
            failed = true;
        }
    }
    failed
}

async fn drain(children: &mut [OwnedChild], deadline: Instant) -> bool {
    let mut failed = false;
    for child in children {
        for mut reader in child.readers.drain(..) {
            match timeout_at(deadline, &mut reader).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => failed = true,
                Err(_) => {
                    reader.abort();
                    failed = true;
                }
            }
        }
    }
    failed
}

/// Run until an operator signal or required child exit, then clean up within one
/// shared deadline. Register signals before spawning so startup can be stopped.
///
/// # Errors
/// Returns setup errors only before any children are spawned. Runtime failures
/// are returned in the report after sibling cleanup.
pub async fn run(config: Config, counters: Arc<LogCounters>) -> io::Result<Report> {
    if config.shutdown_timeout.is_zero()
        || config.shutdown_timeout > Duration::from_secs(20)
        || !(1..=1024).contains(&config.log_capacity)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "shutdown timeout must be 1..=20000 ms and log capacity 1..=1024",
        ));
    }
    let mut term = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut changes = signal(SignalKind::child())?;
    let (logs, mut writer_done) = Logs::start(&config, Arc::clone(&counters))?;
    let mut children = Vec::with_capacity(3);
    let mut reason = None;
    // UDP has no readiness acknowledgement. Ordering avoids a deliberate delay
    // while child supervision detects an unavailable or failed collector.
    for (role, spec) in [
        ("collector", &config.collector),
        ("backend", &config.backend),
        ("caddy", &config.caddy),
    ] {
        match spawn(role, spec, &logs).await {
            Ok(child) => children.push(child),
            Err(error) => {
                reason = Some(ExitReason::SpawnFailed { role, error });
                break;
            }
        }
    }
    let reason = if let Some(reason) = reason {
        reason
    } else {
        loop {
            if let Some(reason) = unexpected(&children) {
                break reason;
            }
            tokio::select! {
                _ = term.recv() => break ExitReason::Signal(Signal::SIGTERM),
                _ = interrupt.recv() => break ExitReason::Signal(Signal::SIGINT),
                _ = changes.recv() => {}
            }
        }
    };
    let start = Instant::now();
    let budget = config.shutdown_timeout;
    let deadline = start + budget;
    let mut timed_out = false;
    if let Some(services) = children.get_mut(1..) {
        timed_out |= stop(
            services,
            &mut changes,
            start + budget.mul_f32(0.7),
            start + budget.mul_f32(0.8),
        )
        .await;
        timed_out |= drain(services, start + budget.mul_f32(0.85)).await;
        timed_out |= logs.drain(start + budget.mul_f32(0.85)).await;
    }
    // Forwarding is synchronous/nonblocking in the pipe readers, so all service
    // UDP sends have finished before the collector receives its stop signal.
    let reason = if let ExitReason::Signal(_) = reason {
        children
            .first()
            .and_then(|child| unexpected(std::slice::from_ref(child)))
            .unwrap_or(reason)
    } else {
        reason
    };
    if let Some(collector) = children.get_mut(0) {
        timed_out |= stop(
            std::slice::from_mut(collector),
            &mut changes,
            start + budget.mul_f32(0.9),
            start + budget.mul_f32(0.95),
        )
        .await;
        timed_out |= drain(
            std::slice::from_mut(collector),
            start + budget.mul_f32(0.95),
        )
        .await;
    }
    drop(logs);
    if timeout_at(deadline, &mut writer_done).await.is_err() {
        timed_out = true;
    }
    Ok(Report {
        reason,
        timed_out,
        logs: counters.snapshot(),
    })
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions report spawn-retry regressions"
)]
mod tests {
    use super::{ChildSpec, Config, LogCounters, Logs, spawn};
    use std::{
        fs, io, os::unix::fs::PermissionsExt as _, path::PathBuf, sync::Arc, time::Duration,
    };

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    /// A real executable, because the busy window only exists for a file the
    /// kernel would otherwise be willing to exec.
    fn executable(dir: &std::path::Path, name: &str) -> io::Result<PathBuf> {
        let path = dir.join(name);
        fs::write(&path, "#!/bin/sh\nexit 0\n")?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
        Ok(path)
    }

    fn logs() -> io::Result<Logs> {
        let (logs, _finished) = Logs::start(&Config::default(), Arc::new(LogCounters::default()))?;
        Ok(logs)
    }

    #[tokio::test]
    async fn spawn_retries_while_the_program_is_still_open_for_writing() -> TestResult {
        let dir = tempfile::tempdir()?;
        let program = executable(dir.path(), "busy")?;
        // An open write handle is precisely what makes execve report ETXTBSY.
        let writer = fs::OpenOptions::new().write(true).open(&program)?;
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            drop(writer);
        });

        let spec = ChildSpec {
            program,
            args: vec![],
        };
        let child = spawn("backend", &spec, &logs()?).await?;

        drop(child);
        assert!(release.join().is_ok(), "release thread should finish");
        Ok(())
    }

    #[tokio::test]
    async fn spawn_does_not_retry_a_missing_program() -> TestResult {
        let dir = tempfile::tempdir()?;
        let spec = ChildSpec {
            program: dir.path().join("absent"),
            args: vec![],
        };

        let started = std::time::Instant::now();
        let result = spawn("backend", &spec, &logs()?).await;

        assert!(
            matches!(&result, Err(error) if error.kind() == io::ErrorKind::NotFound),
            "a missing program must fail with NotFound"
        );
        // A missing program is permanent. Retrying it would only delay the 127.
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "NotFound should fail at once, took {:?}",
            started.elapsed()
        );
        Ok(())
    }
}
