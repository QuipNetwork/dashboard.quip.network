// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import type { IndexerConfig } from "./config";
import type { ChainSource } from "./sources";
import type { IndexerState } from "./state";

export interface ConnectedDeps {
  config: IndexerConfig;
  client: ChainSource;
  db: DatabaseAdapter;
  state: IndexerState;
  now?: () => number;
  chainHeadDebounceMs?: number;
}

export const CHAIN_HEAD_DEBOUNCE_DEFAULT_MS = 1000;

// BABE slot duration on quip-protocol-rs (spec_version 101). Used to
// convert block-delta `miningTime` into seconds — the canonical unit
// every consumer expects (chart axes labelled "seconds", RecentBlocks
// and ComputeAvailable apply `* 1000` for ms). The runtime constant
// `api.consts.babe.slotDuration` would be authoritative but isn't piped
// through telemetry yet; this constant tracks it until that wiring lands.
export const BABE_SLOT_DURATION_SEC = 6;

export function nowIso(deps: ConnectedDeps): string {
  return new Date((deps.now ?? Date.now)()).toISOString();
}

export function backoffMs(attempt: number, capMs: number): number {
  // Exponential with ±20% jitter. attempt 0 → ~1s, 1 → ~2s, …, capped.
  const base = Math.min(1000 * 2 ** attempt, capMs);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, base + jitter);
}
