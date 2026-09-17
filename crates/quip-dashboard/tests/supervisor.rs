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
    Ok(timeout(Duration::from_secs(5), child.wait_with_output()).await??)
}

async fn receive(socket: &UdpSocket, needle: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
    timeout(Duration::from_secs(3), async {
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
    assert_eq!(result.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&result.stderr).contains("backend"));
    Ok(())
}

#[tokio::test]
async fn collector_exit_is_a_distinct_failure() -> Result<(), Box<dyn std::error::Error>> {
    let dir = TempDir::new()?;
    let idle = script(dir.path(), "idle", "signal.pause()")?;
    let exit = script(dir.path(), "exit", "sys.exit(0)")?;
    assert_eq!(
        output(start(&exit, &idle, &idle, "127.0.0.1:9")?)
            .await?
            .status
            .code(),
        Some(70)
    );
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
    assert_eq!(result.status.code(), Some(127));
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
    let backend = script(
        dir.path(),
        "backend",
        &format!(
            "def stop(*args):\n    open({order:?},'a').write('backend\\n')\n    print('backend-final',flush=True)\n    sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nprint('backend-ready',flush=True)\nsignal.pause()"
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
    timeout(Duration::from_secs(3), async {
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
    assert_eq!(output(child).await?.status.code(), Some(0));
    captured.extend(drain.await??);
    assert!(String::from_utf8_lossy(&captured).contains("backend-final"));
    let events = fs::read_to_string(order)?;
    assert_eq!(events.lines().last(), Some("collector"));
    let mut datagrams = Vec::new();
    let mut bytes = vec![0; 65_535];
    while let Ok(count) = socket.try_recv(&mut bytes) {
        datagrams.extend(bytes.iter().take(count));
    }
    let text = String::from_utf8_lossy(&datagrams);
    assert!(text.contains("quip-dashboard: backend-final"));
    assert!(!text.contains("collector-private"));
    Ok(())
}

#[tokio::test]
async fn ignoring_termination_and_descendants_cannot_extend_deadline()
-> Result<(), Box<dyn std::error::Error>> {
    // Act as Tini for this test and reap the orphan instead of leaving a zombie
    // with the host's PID 1. The explicit pid prevents consuming another test's child.
    set_child_subreaper(true)?;
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
    assert_eq!(result.status.code(), Some(124));
    assert_eq!(
        waitpid(Pid::from_raw(descendant), Some(WaitPidFlag::WNOHANG))?,
        WaitStatus::Signaled(Pid::from_raw(descendant), Signal::SIGKILL, false)
    );
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
    assert_eq!(result.status.code(), Some(0));
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
            "for i in range(100000):\n    sys.stdout.write('flood-'+str(i)+'x'*100+'\\n')\nsys.stdout.flush()\nopen({complete:?},'w').write('done')\nsignal.pause()"
        ),
    )?;
    let idle = script(dir.path(), "idle", "signal.pause()")?;
    let mut child = start(&idle, &backend, &idle, "127.0.0.1:9")?;
    // Keep stderr's pipe full while waiting for the producer to finish its flood.
    timeout(Duration::from_secs(4), async {
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
        timeout(Duration::from_secs(3), child.wait()).await??.code(),
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
    timeout(Duration::from_secs(4), async {
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
    assert_eq!(result.status.code(), Some(0));
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
    set_child_subreaper(true)?;
    let dir = TempDir::new()?;
    let pid_file = dir.path().join("pid");
    let backend = script(
        dir.path(),
        "backend",
        &format!(
            "pid=os.fork()\nif pid==0:\n    signal.signal(signal.SIGTERM,signal.SIG_IGN)\n    signal.pause()\nelse:\n    open({pid_file:?},'w').write(str(pid))\n    sys.exit(0)"
        ),
    )?;
    let idle = script(dir.path(), "idle", "signal.pause()")?;
    let mut unrelated = Command::new("/usr/bin/python3")
        .args(["-c", "import signal; signal.pause()"])
        .process_group(0)
        .kill_on_drop(true)
        .spawn()?;
    for _ in 0..5 {
        let result = output(start(&idle, &backend, &idle, "127.0.0.1:9")?).await?;
        assert_eq!(result.status.code(), Some(1));
        let descendant: i32 = fs::read_to_string(&pid_file)?.parse()?;
        assert_eq!(
            waitpid(Pid::from_raw(descendant), Some(WaitPidFlag::WNOHANG))?,
            WaitStatus::Signaled(Pid::from_raw(descendant), Signal::SIGKILL, false)
        );
        assert!(unrelated.try_wait()?.is_none());
    }
    unrelated.kill().await?;
    Ok(())
}
