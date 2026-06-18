// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Supervisor-agnostic deployment contract. An `Application` and a `SetupStep`
// describe WHAT a deployment runs; a `Runner` decides HOW it is supervised.
// Switching process supervisors (tini+bun → s6 → systemd → …) means swapping
// the Runner implementation — these definitions and the planning that produces
// a RunPlan stay put.

// A long-running process the deployment supervises.
export interface Application {
  readonly name: string;
  // The command to launch and the directory to launch it in.
  readonly command: readonly string[];
  readonly cwd: string;
}

// A one-shot command that must succeed (exit 0) before the applications start —
// dependency install, schema migration. Ordered: each gates the next.
export interface SetupStep {
  readonly label: string;
  readonly command: readonly string[];
  readonly cwd: string;
}

// What a runner is handed: setup steps to run to completion, then the
// long-running applications to supervise.
export interface RunPlan {
  readonly setup: readonly SetupStep[];
  readonly apps: readonly Application[];
}

// The adaptor that actually runs a plan under some process supervisor, and
// resolves to the process exit code.
export interface Runner {
  run(plan: RunPlan): Promise<number>;
}
