// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Worker primitives shared by every indexer worker: the orchestration
// contract `Worker`, the connection-invariant `WorkerContext` deps bundle,
// and the time/backoff helpers. The concrete workers live under
// `substrate/`, `tip/`, and `descriptor/`.

import type { DatabaseAdapter } from "@quip/core/db/adapter";

import type { IndexerConfig } from "./config";
import type { IndexerState } from "./state";

// The orchestration contract every worker implements. `main`'s runWorkers
// drives a list of these under one composed AbortSignal.
export interface Worker {
  run(signal: AbortSignal): Promise<void>;
}

// Connection-invariant deps shared by a worker and its collaborators. The
// per-connection client is NOT here — it's constructor-injected per connect.
export interface WorkerContext {
  config: IndexerConfig;
  db: DatabaseAdapter;
  state: IndexerState;
  now: () => number;
}

export function nowIso(ctx: WorkerContext): string {
  return new Date(ctx.now()).toISOString();
}

// Exponential with ±20% jitter: attempt 0 → ~1s, 1 → ~2s, …, capped.
export function backoffMs(attempt: number, capMs: number): number {
  const base = Math.min(1000 * 2 ** attempt, capMs);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, base + jitter);
}
