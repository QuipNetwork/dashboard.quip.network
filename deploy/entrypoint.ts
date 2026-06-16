// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App process supervisor. tini is PID 1 (zombie reaping + signal delivery);
// this process is tini's single child and parents the app's own processes:
// it installs deps (dev only), runs migrate, then spawns the server / indexer
// / frontend, forwards signals, and exits with the first non-zero child code.
//
// Every process is delegated to a workspace package.json script (`bun run
// <script>` with the workspace as cwd) so each app owns its own dev/start
// command. Mode and which children run are env-driven:
//   DEV          run watch/HMR dev scripts + `bun install` first  (default false)
//   RUN_SERVER   start @quip/server   (default true)
//   RUN_INDEXER  start @quip/indexer  (default true)
//   RUN_FRONTEND start @quip/frontend vite dev server (default true, DEV-only)

const APP_DIR = "/app";

type ChildName = "server" | "indexer" | "frontend";

interface AppSpec {
  name: ChildName;
  dir: string;
}

interface Child {
  name: ChildName;
  proc: ReturnType<typeof Bun.spawn>;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.toLowerCase() !== "false" && raw !== "0";
}

const DEV = envFlag("DEV", false);

function runWorkspaceScript(name: ChildName, dir: string, script: string): Child {
  const proc = Bun.spawn({
    cmd: ["bun", "run", script],
    cwd: dir,
    stdout: "inherit",
    stderr: "inherit",
  });
  return { name, proc };
}

async function runToCompletion(label: string, cmd: string[], cwd: string): Promise<number> {
  console.log(`entrypoint: ${label}`);
  const proc = Bun.spawn({ cmd, cwd, stdout: "inherit", stderr: "inherit" });
  return (await proc.exited) ?? 1;
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

function plannedApps(): AppSpec[] {
  const apps: AppSpec[] = [];
  if (envFlag("RUN_SERVER", true)) apps.push({ name: "server", dir: `${APP_DIR}/apps/server` });
  if (envFlag("RUN_INDEXER", true)) apps.push({ name: "indexer", dir: `${APP_DIR}/apps/indexer` });
  // The SPA is static in prod (served by the server from STATIC_DIR); only the
  // dev image runs vite, so the frontend child is DEV-gated.
  if (DEV && envFlag("RUN_FRONTEND", true))
    apps.push({ name: "frontend", dir: `${APP_DIR}/apps/frontend` });
  return apps;
}

async function main(): Promise<number> {
  const apps = plannedApps();
  if (apps.length === 0) {
    console.error(
      "entrypoint: no processes enabled (RUN_SERVER/RUN_INDEXER/RUN_FRONTEND); nothing to do",
    );
    return 1;
  }

  // Dev installs against the bind-mounted source so node_modules tracks the
  // host checkout; prod images bake deps at build time and skip this.
  if (DEV) {
    const installExit = await runToCompletion("bun install (dev)", ["bun", "install"], APP_DIR);
    if (installExit !== 0) {
      console.error(`entrypoint: bun install failed with code ${installExit}`);
      return installExit;
    }
  }

  // Run migrate synchronously before children start so the Postgres schema is
  // applied deterministically before the server and indexer connect.
  const migrateExit = await runToCompletion(
    "running migrate",
    ["bun", "run", "migrate"],
    `${APP_DIR}/apps/server`,
  );
  if (migrateExit !== 0) {
    console.error(`entrypoint: migrate failed with code ${migrateExit}`);
    return migrateExit;
  }

  const script = DEV ? "dev" : "start";
  const children = apps.map((a) => runWorkspaceScript(a.name, a.dir, script));
  console.log(`entrypoint: started ${children.map((c) => c.name).join(", ")} (${script})`);

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
