// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import type { IndexerConfig } from "../config";
import type { IndexerState } from "../state";

// Connection-invariant deps shared by the worker and its collaborators. The
// per-connection `client` is NOT here — it's constructor-injected per connect.
export interface WorkerContext {
  config: IndexerConfig;
  db: DatabaseAdapter;
  state: IndexerState;
  now: () => number;
}

export const CHAIN_HEAD_DEBOUNCE_DEFAULT_MS = 1000;

// BABE slot duration on quip-protocol-rs (spec 101); converts block-delta
// mining_time into seconds. `api.consts.babe.slotDuration` would be
// authoritative but isn't piped through telemetry yet.
export const BABE_SLOT_DURATION_SEC = 6;

export function nowIso(ctx: WorkerContext): string {
  return new Date(ctx.now()).toISOString();
}

// Exponential with ±20% jitter: attempt 0 → ~1s, 1 → ~2s, …, capped.
export function backoffMs(attempt: number, capMs: number): number {
  const base = Math.min(1000 * 2 ** attempt, capMs);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, base + jitter);
}
