// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import type { Application, SetupStep } from "@quip/shared/deployment";

import { BunRunner, type Spawn, type SpawnedProcess } from "./bun-runner";

// A programmable stand-in for a spawned child. `exitOnSigterm` models a
// well-behaved child that stops on SIGTERM; left unset, the child ignores
// SIGTERM (forcing the SIGKILL escalation). SIGKILL always exits 137.
class FakeProcess implements SpawnedProcess {
  exitCode: number | null = null;
  readonly signals: NodeJS.Signals[] = [];
  readonly exited: Promise<number>;
  private resolveExit!: (code: number) => void;

  constructor(private readonly exitOnSigterm?: number) {
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal);
    if (this.exitCode !== null) return;
    if (signal === "SIGKILL") this.exit(137);
    else if (signal === "SIGTERM" && this.exitOnSigterm !== undefined)
      this.exit(this.exitOnSigterm);
  }

  exit(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.resolveExit(code);
  }
}

interface SpawnRecord {
  command: readonly string[];
  cwd: string;
  proc: FakeProcess;
}

// Build an injectable spawn that records every spawn. `make` lets a test decide
// the FakeProcess per command (e.g. a setup step that exits immediately).
function fakeSpawn(make?: (command: readonly string[], cwd: string) => FakeProcess): {
  spawn: Spawn;
  spawns: SpawnRecord[];
} {
  const spawns: SpawnRecord[] = [];
  const spawn: Spawn = (command, cwd) => {
    const proc = make?.(command, cwd) ?? new FakeProcess();
    spawns.push({ command, cwd, proc });
    return proc;
  };
  return { spawn, spawns };
}

// A runner wired for tests: injected spawn, instant grace timer, no real OS
// signal handlers (those are exercised via requestShutdown directly).
function testRunner(spawn: Spawn, installSignalHandlers = false): BunRunner {
  return new BunRunner({ spawn, sleep: async () => {}, killGraceMs: 50, installSignalHandlers });
}

const app = (name: string): Application => ({
  name,
  command: ["bun", "run", "start"],
  cwd: `/app/apps/${name}`,
});

const step = (label: string): SetupStep => ({ label, command: ["bun", "run", label], cwd: "/app" });

function exitedProc(code: number): FakeProcess {
  const proc = new FakeProcess();
  proc.exit(code);
  return proc;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe("BunRunner", () => {
  test("exits with the first child's non-zero code and terminates the survivors", async () => {
    const { spawn, spawns } = fakeSpawn();
    const run = testRunner(spawn).run({ setup: [], apps: [app("server"), app("indexer")] });
    // Apps are spawned synchronously before the first await.
    expect(spawns.map((s) => s.cwd)).toEqual(["/app/apps/server", "/app/apps/indexer"]);

    spawns[0]!.proc.exit(2); // server crashes
    expect(await run).toBe(2);
    expect(spawns[1]!.proc.signals).toContain("SIGTERM"); // indexer was told to stop
  });

  test("exits 0 when the first child exits cleanly", async () => {
    const { spawn, spawns } = fakeSpawn();
    const run = testRunner(spawn).run({ setup: [], apps: [app("server"), app("indexer")] });
    spawns[0]!.proc.exit(0);
    expect(await run).toBe(0);
  });

  test("a failed setup step short-circuits — applications never spawn", async () => {
    const { spawn, spawns } = fakeSpawn((command) =>
      command.includes("migrate") ? exitedProc(3) : new FakeProcess(),
    );
    const code = await testRunner(spawn).run({ setup: [step("migrate")], apps: [app("server")] });
    expect(code).toBe(3);
    expect(spawns).toHaveLength(1); // only the migrate step ran
    expect(spawns[0]!.command).toContain("migrate");
  });

  test("no applications enabled → exit 1 without running setup", async () => {
    const { spawn, spawns } = fakeSpawn();
    const code = await testRunner(spawn).run({ setup: [step("migrate")], apps: [] });
    expect(code).toBe(1);
    expect(spawns).toHaveLength(0);
  });

  test("setup steps run to completion, in order, before any application spawns", async () => {
    const { spawn, spawns } = fakeSpawn((command) =>
      command.includes("install") || command.includes("migrate")
        ? exitedProc(0)
        : new FakeProcess(),
    );
    const run = testRunner(spawn).run({
      setup: [step("install"), step("migrate")],
      apps: [app("server")],
    });
    await flush(); // let the awaited setup steps resolve and the app spawn
    expect(spawns.map((s) => s.command.at(-1))).toEqual(["install", "migrate", "start"]);

    spawns.at(-1)!.proc.exit(0);
    expect(await run).toBe(0);
  });

  test("escalates SIGTERM → SIGKILL for a child that ignores SIGTERM past the grace period", async () => {
    const { spawn, spawns } = fakeSpawn(); // children ignore SIGTERM
    const run = testRunner(spawn).run({ setup: [], apps: [app("server"), app("indexer")] });
    spawns[1]!.proc.exit(0); // indexer exits → triggers shutdown of server
    expect(await run).toBe(0);
    expect(spawns[0]!.proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("a child that exits on SIGTERM is not SIGKILLed", async () => {
    const { spawn, spawns } = fakeSpawn((_command, cwd) =>
      cwd.endsWith("indexer") ? new FakeProcess(143) : new FakeProcess(),
    );
    const run = testRunner(spawn).run({ setup: [], apps: [app("server"), app("indexer")] });
    spawns[0]!.proc.exit(0); // server exits → shutdown SIGTERMs indexer
    expect(await run).toBe(0);
    expect(spawns[1]!.proc.signals).toEqual(["SIGTERM"]); // graceful — no SIGKILL
  });

  test("requestShutdown reports a SIGTERM-caused (143) child exit as success", async () => {
    const { spawn, spawns } = fakeSpawn(() => new FakeProcess(143));
    const runner = testRunner(spawn);
    const run = runner.run({ setup: [], apps: [app("server")] });
    // Children are spawned synchronously, so requestShutdown sees them.
    await runner.requestShutdown();
    expect(await run).toBe(0);
    expect(spawns[0]!.proc.signals).toEqual(["SIGTERM"]);
  });

  test("run() does not resolve until every child is reaped, even on a signal-initiated shutdown", async () => {
    // server stops on SIGTERM; indexer ignores it and only dies on SIGKILL
    // after the (real) grace timer. A real Bun.sleep here also exercises the
    // grace-escalation timing the other tests collapse with an instant sleep.
    const { spawn, spawns } = fakeSpawn((_command, cwd) =>
      cwd.endsWith("server") ? new FakeProcess(143) : new FakeProcess(),
    );
    const runner = new BunRunner({ spawn, killGraceMs: 30, installSignalHandlers: false });
    const run = runner.run({ setup: [], apps: [app("server"), app("indexer")] });

    void runner.requestShutdown(); // signal-style stop, not awaited
    const code = await run;

    // Both children must be fully reaped by the time run() resolves.
    expect(spawns[0]!.proc.exitCode).toBe(143);
    expect(spawns[1]!.proc.exitCode).toBe(137); // SIGKILLed after the grace period
    expect(spawns[1]!.proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(code).toBe(0); // signal-initiated + a 143 first-exit → success
  });
});
