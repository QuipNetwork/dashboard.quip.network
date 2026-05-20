// SPDX-License-Identifier: AGPL-3.0-or-later

import { create } from "zustand";
import type {
  BabeAuthorityRecord,
  BabeEpochState,
  BlockRecord,
  ChainHead,
  ChainMinerRecord,
  DifficultyRecord,
  IndexerObservability,
  TelemetryResponse,
  ValidatorAuthorshipRecord,
} from "../types/telemetry";

export interface TelemetryState {
  blocks: BlockRecord[];
  selfAddress: string | null;
  indexer: IndexerObservability | null;
  // ISO 8601 server timestamp from the last /api/telemetry response.
  // Used as the "now" anchor in health checks so a backgrounded tab
  // doesn't compute inflated ages from cached responses (audit fix #3).
  serverTime: string | null;
  chainHead: ChainHead | null;
  babeEpoch: BabeEpochState | null;
  babeAuthorities: BabeAuthorityRecord[];
  chainMiners: ChainMinerRecord[];
  recentDifficulty: DifficultyRecord[];
  validators: ValidatorAuthorshipRecord[];
  loading: boolean;
  error: string | null;

  fetchTelemetry: () => Promise<void>;
}

export const useTelemetryStore = create<TelemetryState>((set, get) => ({
  blocks: [],
  selfAddress: null,
  indexer: null,
  serverTime: null,
  chainHead: null,
  babeEpoch: null,
  babeAuthorities: [],
  chainMiners: [],
  recentDifficulty: [],
  validators: [],
  loading: true,
  error: null,
  fetchTelemetry: async () => {
    // Only flash the loading screen on the very first load. Subsequent
    // polling refreshes leave the current UI visible and swap data in place.
    // In steady state both blocks and selfAddress are populated, so this
    // never re-enters the loading flash after the first successful fetch.
    const firstLoad = get().blocks.length === 0 && get().selfAddress === null;
    if (firstLoad && !get().loading) set({ loading: true });
    try {
      const res = await fetch("/api/telemetry");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as TelemetryResponse;
      set({
        blocks: data.blocks,
        selfAddress: data.selfAddress,
        indexer: data.indexer,
        serverTime: data.serverTime,
        chainHead: data.chainHead,
        babeEpoch: data.babeEpoch,
        babeAuthorities: data.babeAuthorities,
        chainMiners: data.chainMiners,
        recentDifficulty: data.recentDifficulty,
        validators: data.validators,
        loading: false,
        error: null,
      });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
}));

// --- Selectors ---

/**
 * Server-anchored "now" in ms. Returns the parsed `serverTime` from the most
 * recent telemetry response, or `Date.now()` if no response has landed yet
 * (initial connect). Use this in place of `Date.now()` when computing ages
 * relative to indexer/server fields — fixes audit #3 (backgrounded tab shows
 * inflated heartbeat ages because the cached response's lastStatusFetchAt is
 * server-stamped but the comparison anchor was client-clock).
 */
export const selectServerNowMs = (s: TelemetryState): number =>
  s.serverTime ? Date.parse(s.serverTime) : Date.now();

/**
 * The tip block, or null when no blocks are loaded. The API ships blocks
 * sorted DESC by substrate_block_number (see api/db/sqlite.ts and
 * api/db/postgres.ts), so the tip is the first element. Returns a reference
 * stable between fetches (same BlockRecord identity in the array), so it's
 * safe to pass directly to `useTelemetryStore(selectTipBlock)`. Don't layer a
 * derived-object selector on top: zustand compares by reference and a fresh
 * `{ ...fields }` each call would loop forever.
 */
export const selectTipBlock = (s: TelemetryState): BlockRecord | null =>
  s.blocks.length > 0 ? (s.blocks[0] ?? null) : null;

/** Timestamp (ms) of the tip block, or null when no blocks are loaded. */
export const selectTipBlockTimestampMs = (s: TelemetryState): number | null => {
  const tip = selectTipBlock(s);
  return tip ? tip.timestamp * 1000 : null;
};
