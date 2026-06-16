// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Container entrypoint: spawns the indexer and/or server, forwards signals,
// and exits with the first non-zero child exit code.

type ChildName = "server" | "indexer";

interface Child {
  name: ChildName;
  proc: ReturnType<typeof Bun.spawn>;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.toLowerCase() !== "false" && raw !== "0";
}

function spawnChild(name: ChildName, entry: string): Child {
  const proc = Bun.spawn({
    cmd: ["bun", "run", entry],
    stdout: "inherit",
    stderr: "inherit",
  });
  return { name, proc };
}

async function waitFirst(children: Child[]): Promise<{ name: ChildName; code: number }> {
  const races = children.map((c) =>
    c.proc.exited.then((code) => ({ name: c.name, code: code ?? 0 })),
  );
  return Promise.race(races);
}

// Module-scoped so signal handlers and main() share one shutdown path.
let shuttingDown = false;
let shutdownSignaled = false;

async function shutdown(children: Child[], signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`entrypoint: received ${signal}, terminating children`);
  for (const c of children) {
    if (c.proc.exitCode !== null) continue;
    try {
      c.proc.kill("SIGTERM");
    } catch (e) {
      console.error(`entrypoint: SIGTERM to ${c.name} failed:`, e);
    }
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (children.every((c) => c.proc.exitCode !== null)) return;
    await Bun.sleep(100);
  }
  for (const c of children) {
    if (c.proc.exitCode !== null) continue;
    console.error(`entrypoint: ${c.name} did not exit in 10s, sending SIGKILL`);
    try {
      c.proc.kill("SIGKILL");
    } catch (e) {
      console.error(`entrypoint: SIGKILL to ${c.name} failed:`, e);
    }
  }
  // Make sure every child is reaped so main() does not exit before children.
  await Promise.all(children.map((c) => c.proc.exited));
}

async function main(): Promise<number> {
  const runServer = envFlag("RUN_SERVER", true);
  const runIndexer = envFlag("RUN_INDEXER", true);

  if (!runServer && !runIndexer) {
    console.error("entrypoint: both RUN_SERVER and RUN_INDEXER are false; nothing to do");
    return 1;
  }

  // Run migrate synchronously before children start so the Postgres schema is
  // applied deterministically before the server and indexer connect.
  console.log("entrypoint: running migrate");
  const migrateProc = Bun.spawn({
    cmd: ["bun", "run", "/app/apps/server/migrate.ts"],
    stdout: "inherit",
    stderr: "inherit",
  });
  const migrateExit = (await migrateProc.exited) ?? 1;
  if (migrateExit !== 0) {
    console.error(`entrypoint: migrate failed with code ${migrateExit}`);
    return migrateExit;
  }

  const children: Child[] = [];
  if (runServer) children.push(spawnChild("server", "/app/apps/server/main.ts"));
  if (runIndexer) children.push(spawnChild("indexer", "/app/apps/indexer/main.ts"));

  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  for (const sig of signals) {
    process.on(sig, () => {
      shutdownSignaled = true;
      void shutdown(children, sig);
    });
  }

  const first = await waitFirst(children);
  console.error(`entrypoint: ${first.name} exited with code ${first.code}`);
  await shutdown(children, "SIGTERM");

  // If we initiated shutdown from a signal, treat a clean (or SIGTERM-caused)
  // child exit as success — the orchestrator asked us to stop.
  if (shutdownSignaled && (first.code === 0 || first.code === 143)) {
    return 0;
  }
  return first.code;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("entrypoint: fatal", err);
    process.exit(1);
  },
);
