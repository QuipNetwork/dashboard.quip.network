//! Real subprocess tests for shutdown, process groups, and bounded logging.

#![expect(
    clippy::panic_in_result_fn,
    reason = "Tests propagate setup errors and use assertions for behavioral failures."
)]

use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Stdio, time::Duration};

use nix::{
    sys::{
        prctl::set_child_subreaper,
        signal::{Signal, kill},
        wait::{WaitPidFlag, WaitStatus, waitpid},
    },
    unistd::Pid,
};
use tempfile::TempDir;
use tokio::{
    io::AsyncReadExt,
    net::UdpSocket,
    process::{Child, Command},
    time::timeout,
};

/// Test-side deadline for waiting on a real subprocess.
///
/// These tests drive real operating-system processes and real pipes, so a
/// virtual clock does not reach them and the wait is genuine wall-clock time.
/// The default is generous on purpose, and that generosity is a real
/// trade-off, not a free one: a healthy run still satisfies it in
/// milliseconds, and a supervisor that hangs outright still fails at any
/// value, but a supervisor that merely grows slower now has thirty seconds of
/// room where it used to have three. A regression that adds seconds to
/// shutdown would pass here. `SUPERVISOR_TEST_DEADLINE_SECS` is the knob for
/// hunting that class of regression. Two pipelines sharing a runner pushed the
/// old three-second wait over its limit, which is why the default grew.
fn io_deadline() -> Duration {
    Duration::from_secs(
        std::env::var("SUPERVISOR_TEST_DEADLINE_SECS")
            .ok()
            .and_then(|raw| raw.parse().ok())
            .unwrap_or(30),
    )
}

/// Budget for a fixture to finish producing, which is not the behaviour any
/// test asserts. Producing scales with contention while the shutdown under
/// test does not, so it gets its own generous value: sharing `io_deadline`
/// made a slow producer fail as though shutdown had stalled.
fn setup_deadline() -> Duration {
    io_deadline().saturating_mul(4)
}

fn script(dir: &Path, name: &str, body: &str) -> std::io::Result<String> {
    let path = dir.join(name);
    fs::write(
        &path,
        format!("#!/usr/bin/python3\nimport os,signal,time,sys\n{body}\n"),
    )?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
    Ok(path.to_string_lossy().into_owned())
}

fn start(collector: &str, backend: &str, caddy: &str, address: &str) -> std::io::Result<Child> {
    // Act as Tini for this binary and reap orphans instead of leaving zombies
    // with the host's PID 1. The attribute is process-wide and inherited across
    // fork, so setting it inside individual tests made every later supervisor
    // depend on which tests had already run, and all nine share one process.
    // Every test spawns through here and the prctl is idempotent, so setting it
    // here is uniform regardless of test order. Tests that wait on a descendant
    // still name an explicit pid, which is what keeps them from consuming
    // another test's child.
    set_child_subreaper(true).map_err(std::io::Error::from)?;
    Command::new(env!("CARGO_BIN_EXE_quip-dashboard-supervisor"))
        .args([
            "--collector-program",
            collector,
            "--backend-program",
            backend,
            "--caddy-program",
            caddy,
            "--syslog-address",
            address,
            "--shutdown-timeout-ms",
            "800",
            "--log-capacity",
            "4",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
}

async fn output(child: Child) -> Result<std::process::Output, Box<dyn std::error::Error>> {
    Ok(timeout(io_deadline(), child.wait_with_output()).await??)
}

/// Assert the supervisor's exit code, reporting its own diagnostics on failure.
///
/// The supervisor prints `reason=...` to stderr before exiting, and a spawn
/// failure carries the underlying `io::Error` there, errno included. Comparing
/// the code alone discards that: a CI run that exited 126 reported only the
/// number, and 126 covers every spawn error except a missing file, so the
/// cause was unrecoverable from the failure output.
fn assert_exit_code(result: &std::process::Output, expected: i32) {
    let stderr = String::from_utf8_lossy(&result.stderr);
    let tail = match stderr.char_indices().nth_back(4096) {
        Some((offset, _)) => stderr.get(offset..).unwrap_or(&stderr),
        None => &stderr,
    };
    assert_eq!(
        result.status.code(),
        Some(expected),
        "supervisor stderr (last {} chars):\n{tail}",
        tail.chars().count()
    );
}

/// Assert a descendant was killed by `expected`, waiting for it to be reapable.
///
/// `WNOHANG` answers about the instant it is called, and the instant the
/// supervisor exits is not the instant its killed grandchild is reparented to
/// this process and becomes reapable. A single probe therefore reports
/// `StillAlive` on a loaded runner for a descendant the supervisor did kill.
/// Polling asserts the same property without requiring the kill and the probe
/// to land in the same moment; a descendant that is never killed still fails,
/// by exhausting [`io_deadline`].
async fn assert_killed_by(
    descendant: Pid,
    expected: Signal,
) -> Result<(), Box<dyn std::error::Error>> {
    let status = timeout(io_deadline(), async {
        loop {
            let status = waitpid(descendant, Some(WaitPidFlag::WNOHANG))?;
            if status != WaitStatus::StillAlive {
                return Ok::<_, nix::Error>(status);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await??;
    assert_eq!(status, WaitStatus::Signaled(descendant, expected, false));
    Ok(())
}

async fn receive(socket: &UdpSocket, needle: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
    timeout(io_deadline(), async {
        let mut bytes = vec![0_u8; 65_535];
        loop {
            let length = socket.recv(&mut bytes).await?;
            if bytes
                .get(..length)
                .ok_or_else(|| std::io::Error::other("invalid datagram length"))?
                .windows(needle.len())
                .any(|window| window == needle)
            {
                return Ok::<_, std::io::Error>(());
            }
        }
    })
    .await??;
    Ok(())
}

#[tokio::test]
async fn clean_child_exit_fails_and_stops_siblings() -> Result<(), Box<dyn std::error::Error>> {
    let dir = TempDir::new()?;
    let idle = script(dir.path(), "idle", "signal.pause()")?;
    let exit = script(dir.path(), "exit", "sys.exit(0)")?;
    let result = output(start(&idle, &exit, &idle, "127.0.0.1:9")?).await?;
    assert_exit_code(&result, 1);
    assert!(String::from_utf8_lossy(&result.stderr).contains("backend"));
    Ok(())
}

#[tokio::test]
async fn collector_exit_is_a_distinct_failure() -> Result<(), Box<dyn std::error::Error>> {
    let dir = TempDir::new()?;
    let idle = script(dir.path(), "idle", "signal.pause()")?;
    let exit = script(dir.path(), "exit", "sys.exit(0)")?;
    let result = output(start(&exit, &idle, &idle, "127.0.0.1:9")?).await?;
    assert_exit_code(&result, 70);
    Ok(())
}

#[tokio::test]
async fn missing_executable_returns_127() -> Result<(), Box<dyn std::error::Error>> {
    let result = output(start(
        "/does-not-exist/collector",
        "/bin/true",
        "/bin/true",
        "127.0.0.1:9",
    )?)
    .await?;
    assert_exit_code(&result, 127);
    Ok(())
}

#[tokio::test]
async fn signal_drains_services_before_collector_without_forwarding_collector_logs()
-> Result<(), Box<dyn std::error::Error>> {
    let dir = TempDir::new()?;
    let order = dir.path().join("order");
    let collector = script(
        dir.path(),
        "collector",
        &format!(
            "def stop(*args):\n    open({order:?},'a').write('collector\\n')\n    sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nprint('collector-private',file=sys.stderr,flush=True)\nsignal.pause()"
        ),
    )?;
    // Both writes go through `os.write` rather than `print`. The supervisor
    // forwards a line as soon as the write syscall lands, which is before
    // `print` has returned, so the test can signal while the interpreter is
    // still inside the readiness `print`. Python runs the handler on the main
    // thread between bytecodes, and a handler that calls `print` on the
    // BufferedWriter the interrupted call still owns raises `RuntimeError:
    // reentrant call`. The backend then dies without writing its final line,
    // failing this test for a reason that has nothing to do with draining.
    let backend = script(
        dir.path(),
        "backend",
        &format!(
            "def stop(*args):\n    open({order:?},'a').write('backend\\n')\n    os.write(1,b'backend-final\\n')\n    sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nos.write(1,b'backend-ready\\n')\nsignal.pause()"
        ),
    )?;
    let caddy = script(
        dir.path(),
        "caddy",
        &format!(
            "def stop(*args):\n    open({order:?},'a').write('caddy\\n')\n    sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nprint('caddy-ready',flush=True)\nsignal.pause()"
        ),
    )?;
    let socket = UdpSocket::bind("127.0.0.1:0").await?;
    let mut child = start(
        &collector,
        &backend,
        &caddy,
        &socket.local_addr()?.to_string(),
    )?;
    // Read readiness from stderr so neither service's UDP datagram can be consumed accidentally.
    let mut stderr = child.stderr.take().ok_or("missing stderr")?;
    let mut captured = Vec::new();
    timeout(io_deadline(), async {
        let mut bytes = [0; 1024];
        while !["backend-ready", "caddy-ready", "collector-private"]
            .iter()
            .all(|s| String::from_utf8_lossy(&captured).contains(s))
        {
            let count = stderr.read(&mut bytes).await?;
            if count == 0 {
                return Err(std::io::Error::other("early EOF"));
            }
            captured.extend(bytes.iter().take(count));
        }
        Ok::<_, std::io::Error>(())
    })
    .await??;
    kill(
        Pid::from_raw(i32::try_from(child.id().ok_or("missing pid")?)?),
        Signal::SIGTERM,
    )?;
    let drain = tokio::spawn(async move {
        let mut rest = Vec::new();
        stderr.read_to_end(&mut rest).await.map(|_| rest)
    });
    let result = output(child).await?;
    assert_exit_code(&result, 0);
    captured.extend(drain.await??);
    let forwarded = String::from_utf8_lossy(&captured);
    assert!(
        forwarded.contains("backend-final"),
        "supervisor stderr:\n{forwarded}"
    );
    let events = fs::read_to_string(order)?;
    assert_eq!(events.lines().last(), Some("collector"));
    let mut datagrams = Vec::new();
    let mut bytes = vec![0; 65_535];
    while let Ok(count) = socket.try_recv(&mut bytes) {
        datagrams.extend(bytes.iter().take(count));
    }
    let text = String::from_utf8_lossy(&datagrams);
    assert!(
        text.contains("quip-dashboard: backend-final"),
        "datagrams:\n{text}\nsupervisor stderr:\n{forwarded}"
    );
    assert!(!text.contains("collector-private"), "datagrams:\n{text}");
    Ok(())
}

#[tokio::test]
async fn ignoring_termination_and_descendants_cannot_extend_deadline()
-> Result<(), Box<dyn std::error::Error>> {
    let dir = TempDir::new()?;
    let pid_file = dir.path().join("pid");
    let backend = script(
        dir.path(),
        "backend",
        &format!(
            "signal.signal(signal.SIGTERM,signal.SIG_IGN)\npid=os.fork()\nif pid==0:\n    signal.pause()\nelse:\n    open({pid_file:?},'w').write(str(pid))\n    print('ready',flush=True)\n    signal.pause()"
        ),
    )?;
    let idle = script(dir.path(), "idle", "signal.pause()")?;
    let socket = UdpSocket::bind("127.0.0.1:0").await?;
    let child = start(&idle, &backend, &idle, &socket.local_addr()?.to_string())?;
    receive(&socket, b"ready").await?;
    let descendant: i32 = fs::read_to_string(pid_file)?.parse()?;
    kill(
        Pid::from_raw(i32::try_from(child.id().ok_or("missing pid")?)?),
        Signal::SIGINT,
    )?;
    let result = output(child).await?;
    assert_exit_code(&result, 124);
    assert_killed_by(Pid::from_raw(descendant), Signal::SIGKILL).await?;
    Ok(())
}

#[tokio::test]
async fn enormous_lines_are_discarded_and_cr_is_sanitized() -> Result<(), Box<dyn std::error::Error>>
{
    let dir = TempDir::new()?;
    let backend = script(
        dir.path(),
        "backend",
        "sys.stdout.write('x'*2000000+'\\nhello\\rforged\\tkeep-tab\\nready\\n');sys.stdout.flush();signal.pause()",
    )?;
    let idle = script(dir.path(), "idle", "signal.pause()")?;
    let socket = UdpSocket::bind("127.0.0.1:0").await?;
    let child = start(&idle, &backend, &idle, &socket.local_addr()?.to_string())?;
    receive(&socket, b"hello forged\tkeep-tab").await?;
    kill(
        Pid::from_raw(i32::try_from(child.id().ok_or("missing pid")?)?),
        Signal::SIGTERM,
    )?;
    let result = output(child).await?;
    assert_exit_code(&result, 0);
    let text = String::from_utf8_lossy(&result.stderr);
    assert!(text.contains("oversized_lines=1"));
    assert!(!text.contains(&"x".repeat(1000)));
    Ok(())
}

#[tokio::test]
async fn flood_with_blocked_stderr_and_absent_receiver_does_not_stall_shutdown()
-> Result<(), Box<dyn std::error::Error>> {
    let dir = TempDir::new()?;
    let complete = dir.path().join("complete");
    let backend = script(
        dir.path(),
        "backend",
        &format!(
            "for i in range(20000):\n    sys.stdout.write('flood-'+str(i)+'x'*100+'\\n')\nsys.stdout.flush()\nopen({complete:?},'w').write('done')\nsignal.pause()"
        ),
    )?;
    let idle = script(dir.path(), "idle", "signal.pause()")?;
    let mut child = start(&idle, &backend, &idle, "127.0.0.1:9")?;
    // Keep stderr's pipe full while waiting for the producer to finish its
    // flood. The producer's own runtime is not what this test asserts, so it
    // draws on `setup_deadline`; only the shutdown below is measured against
    // `io_deadline`.
    timeout(setup_deadline(), async {
        while !complete.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    kill(
        Pid::from_raw(i32::try_from(child.id().ok_or("missing pid")?)?),
        Signal::SIGTERM,
    )?;
    assert_eq!(
        timeout(io_deadline(), child.wait()).await??.code(),
        Some(124)
    );
    Ok(())
}

#[tokio::test]
async fn queue_pressure_preserves_exact_drop_counts() -> Result<(), Box<dyn std::error::Error>> {
    let dir = TempDir::new()?;
    let complete = dir.path().join("complete");
    let backend = script(
        dir.path(),
        "backend",
        &format!(
            "for i in range(10000):\n    sys.stdout.write('item-'+str(i)+'x'*100+'\\n')\nsys.stdout.flush()\nopen({complete:?},'w').write('done')\nsignal.pause()"
        ),
    )?;
    let idle = script(dir.path(), "idle", "signal.pause()")?;
    let child = start(&idle, &backend, &idle, "127.0.0.1:9")?;
    timeout(io_deadline(), async {
        while !complete.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    kill(
        Pid::from_raw(i32::try_from(child.id().ok_or("missing pid")?)?),
        Signal::SIGTERM,
    )?;
    let result = output(child).await?;
    assert_exit_code(&result, 0);
    let text = String::from_utf8_lossy(&result.stderr);
    let delivered = text
        .lines()
        .filter(|line| line.starts_with("<14>quip-dashboard: item-"))
        .count();
    let dropped: usize = text
        .split_whitespace()
        .find_map(|word| word.strip_prefix("stderr_dropped_lines="))
        .ok_or("missing drop counter")?
        .parse()?;
    assert!(dropped > 0);
    assert_eq!(delivered + dropped, 10000);
    assert!(text.contains("stderr_pending_lines=0"));
    Ok(())
}

#[tokio::test]
async fn exited_leaders_retain_group_ownership_until_descendants_are_killed()
-> Result<(), Box<dyn std::error::Error>> {
    let dir = TempDir::new()?;
    let pid_file = dir.path().join("pid");
    let staging = dir.path().join("pid.staging");
    // The descendant reports its own readiness, and the leader waits for that
    // report before exiting. The leader's clean exit is what starts the
    // supervisor's shutdown, so a leader that exits first leaves the supervisor
    // free to signal the group before the descendant has installed SIG_IGN. The
    // default disposition then kills the descendant with SIGTERM, where this
    // test requires the SIGKILL escalation. Writing to a staging path and
    // renaming keeps the report atomic, so the leader cannot observe a pid file
    // that exists but is still empty.
    let backend = script(
        dir.path(),
        "backend",
        &format!(
            "pid=os.fork()\nif pid==0:\n    signal.signal(signal.SIGTERM,signal.SIG_IGN)\n    open({staging:?},'w').write(str(os.getpid()))\n    os.rename({staging:?},{pid_file:?})\n    signal.pause()\nelse:\n    while not os.path.exists({pid_file:?}):\n        time.sleep(0.005)\n    sys.exit(0)"
        ),
    )?;
    let idle = script(dir.path(), "idle", "signal.pause()")?;
    let mut unrelated = Command::new("/usr/bin/python3")
        .args(["-c", "import signal; signal.pause()"])
        .process_group(0)
        .kill_on_drop(true)
        .spawn()?;
    for _ in 0..5 {
        // Each round waits for its own report, so the previous one cannot
        // satisfy the handshake early and reintroduce the race it closes.
        if pid_file.exists() {
            fs::remove_file(&pid_file)?;
        }
        let result = output(start(&idle, &backend, &idle, "127.0.0.1:9")?).await?;
        assert_exit_code(&result, 1);
        let descendant: i32 = fs::read_to_string(&pid_file)?.parse()?;
        assert_killed_by(Pid::from_raw(descendant), Signal::SIGKILL).await?;
        assert!(unrelated.try_wait()?.is_none());
    }
    unrelated.kill().await?;
    Ok(())
}
