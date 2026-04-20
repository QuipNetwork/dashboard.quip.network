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

async function shutdown(children: Child[], signal: NodeJS.Signals): Promise<void> {
  console.error(`entrypoint: received ${signal}, terminating children`);
  for (const c of children) {
    try {
      c.proc.kill("SIGTERM");
    } catch {
      // already dead
    }
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (children.every((c) => c.proc.exitCode !== null)) return;
    await Bun.sleep(100);
  }
  for (const c of children) {
    if (c.proc.exitCode === null) {
      console.error(`entrypoint: ${c.name} did not exit, sending SIGKILL`);
      try {
        c.proc.kill("SIGKILL");
      } catch {
        // race with natural exit
      }
    }
  }
}

async function main(): Promise<number> {
  const runServer = envFlag("RUN_SERVER", true);
  const runIndexer = envFlag("RUN_INDEXER", true);

  if (!runServer && !runIndexer) {
    console.error("entrypoint: both RUN_SERVER and RUN_INDEXER are false; nothing to do");
    return 1;
  }

  const children: Child[] = [];
  if (runServer) children.push(spawnChild("server", "/app/server/main.ts"));
  if (runIndexer) children.push(spawnChild("indexer", "/app/indexer/main.ts"));

  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  for (const sig of signals) {
    process.on(sig, () => {
      void shutdown(children, sig);
    });
  }

  const first = await waitFirst(children);
  console.error(`entrypoint: ${first.name} exited with code ${first.code}`);
  await shutdown(children, "SIGTERM");
  return first.code;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("entrypoint: fatal", err);
    process.exit(1);
  },
);
