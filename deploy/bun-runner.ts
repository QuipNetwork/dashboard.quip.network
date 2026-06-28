// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bun process-supervisor adaptor. Runs a RunPlan as child processes under this
// (tini-parented) Bun process: setup steps to completion first (fail fast),
// then the applications spawned and supervised — forward SIGTERM/SIGINT, exit
// with the first child's code, and escalate SIGTERM→SIGKILL for any child that
// overruns the shutdown grace period.
//
// Everything supervisor-specific lives here. To target a stricter supervisor,
// implement `Runner` in a sibling adaptor; the contract and the entrypoint's
// planning don't change.

import type { RunPlan, Runner, SetupStep } from "@quip/shared/deployment";

// The slice of a spawned process the runner needs — injectable so the
// supervision logic is testable without real processes.
export interface SpawnedProcess {
  // Resolves with the exit code when the process exits.
  readonly exited: Promise<number>;
  // Current exit code, or null while still running.
  readonly exitCode: number | null;
  kill(signal: NodeJS.Signals): void;
}

export type Spawn = (command: readonly string[], cwd: string) => SpawnedProcess;

export interface BunRunnerOptions {
  // Defaults to a real Bun.spawn with inherited stdio.
  spawn?: Spawn;
  // Grace period before a child that ignored SIGTERM is SIGKILLed.
  killGraceMs?: number;
  // Injectable timer; defaults to Bun.sleep.
  sleep?: (ms: number) => Promise<void>;
  // Whether the runner installs SIGTERM/SIGINT handlers. Turn off when the
  // surrounding supervisor owns signal delivery to the children itself.
  installSignalHandlers?: boolean;
}

const DEFAULT_KILL_GRACE_MS = 10_000;

const bunSpawn: Spawn = (command, cwd) => {
  const proc = Bun.spawn({ cmd: [...command], cwd, stdout: "inherit", stderr: "inherit" });
  return {
    exited: proc.exited.then((code) => code ?? 0),
    get exitCode() {
      return proc.exitCode;
    },
    kill: (signal) => {
      proc.kill(signal);
    },
  };
};

interface Child {
  name: string;
  proc: SpawnedProcess;
}

export class BunRunner implements Runner {
  private readonly spawn: Spawn;
  private readonly killGraceMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly manageSignals: boolean;
  private children: Child[] = [];
  // Defaults to resolved — "nothing to shut down yet". The first shutdown
  // replaces it so every caller awaits the same teardown.
  private shuttingDown = false;
  private shutdownPromise: Promise<void> = Promise.resolve();
  private shutdownSignaled = false;

  constructor(opts: BunRunnerOptions = {}) {
    this.spawn = opts.spawn ?? bunSpawn;
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
    this.manageSignals = opts.installSignalHandlers ?? true;
  }

  async run(plan: RunPlan): Promise<number> {
    if (plan.apps.length === 0) {
      console.error("entrypoint: no applications enabled; nothing to do");
      return 1;
    }

    for (const step of plan.setup) {
      const code = await this.runToCompletion(step);
      if (code !== 0) {
        console.error(`entrypoint: ${step.label} failed with code ${code}`);
        return code;
      }
    }

    this.children = plan.apps.map((app) => ({
      name: app.name,
      proc: this.spawn(app.command, app.cwd),
    }));
    const children = this.children;
    console.log(`entrypoint: started ${children.map((c) => c.name).join(", ")}`);

    const removeSignalHandlers = this.manageSignals ? this.installSignalHandlers() : noop;
    try {
      const first = await this.waitFirst(children);
      console.error(`entrypoint: ${first.name} exited with code ${first.code}`);
      await this.shutdown(children);

      // A signal-initiated shutdown treats a clean (or SIGTERM-caused, 143)
      // child exit as success — the supervisor asked us to stop.
      if (this.shutdownSignaled && (first.code === 0 || first.code === 143)) {
        return 0;
      }
      return first.code;
    } finally {
      removeSignalHandlers();
    }
  }

  private async runToCompletion(step: SetupStep): Promise<number> {
    console.log(`entrypoint: ${step.label}`);
    return this.spawn(step.command, step.cwd).exited;
  }

  private waitFirst(children: Child[]): Promise<{ name: string; code: number }> {
    return Promise.race(
      children.map((c) => c.proc.exited.then((code) => ({ name: c.name, code }))),
    );
  }

  // Graceful stop on demand: terminate the children and mark the run as
  // signal-initiated so a clean child exit is reported as success. The signal
  // handlers call this; a supervisor that delivers "stop" some other way (a
  // control socket, an API) can call it directly.
  async requestShutdown(): Promise<void> {
    this.shutdownSignaled = true;
    await this.shutdown(this.children);
  }

  private installSignalHandlers(): () => void {
    const installed: Array<[NodeJS.Signals, () => void]> = [];
    for (const sig of ["SIGTERM", "SIGINT"] as NodeJS.Signals[]) {
      const handler = () => {
        console.error(`entrypoint: received ${sig}, terminating children`);
        void this.requestShutdown();
      };
      process.on(sig, handler);
      installed.push([sig, handler]);
    }
    return () => {
      for (const [sig, handler] of installed) process.off(sig, handler);
    };
  }

  // Memoised so every caller — run()'s post-wait teardown AND a concurrent
  // signal handler / requestShutdown — awaits the SAME teardown. Without this,
  // a signal-initiated shutdown lets run() resolve (and process.exit) before
  // the children are reaped; matters most under a supervisor without tini to
  // reap orphans.
  private shutdown(children: Child[]): Promise<void> {
    if (!this.shuttingDown) {
      this.shuttingDown = true;
      this.shutdownPromise = this.doShutdown(children);
    }
    return this.shutdownPromise;
  }

  // SIGTERM every live child, wait up to the grace period for all to exit, then
  // SIGKILL any straggler. Resolves only once every child is reaped.
  private async doShutdown(children: Child[]): Promise<void> {
    this.signalLiveChildren(children, "SIGTERM");

    const allExited = Promise.all(children.map((c) => c.proc.exited));
    const timedOut = await Promise.race([
      allExited.then(() => false),
      this.sleep(this.killGraceMs).then(() => true),
    ]);
    if (timedOut) {
      for (const c of children) {
        if (c.proc.exitCode !== null) continue;
        console.error(
          `entrypoint: ${c.name} did not exit in ${this.killGraceMs}ms, sending SIGKILL`,
        );
      }
      this.signalLiveChildren(children, "SIGKILL");
    }
    await allExited;
  }

  private signalLiveChildren(children: Child[], signal: NodeJS.Signals): void {
    for (const c of children) {
      if (c.proc.exitCode !== null) continue;
      try {
        c.proc.kill(signal);
      } catch (e) {
        console.error(`entrypoint: ${signal} to ${c.name} failed:`, e);
      }
    }
  }
}

function noop(): void {}
