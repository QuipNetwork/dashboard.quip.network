import { create } from "zustand";
import type {
  BabeAuthorityRecord,
  BabeEpochState,
  BlockRecord,
  ChainHead,
  ChainMinerRecord,
  DifficultyRecord,
  IndexerObservability,
  NodesSnapshot,
  TelemetryResponse,
} from "../types/telemetry";

export interface TelemetryState {
  blocks: BlockRecord[];
  nodes: NodesSnapshot | null;
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
  loading: boolean;
  error: string | null;

  fetchTelemetry: () => Promise<void>;
}

export const useTelemetryStore = create<TelemetryState>((set, get) => ({
  blocks: [],
  nodes: null,
  selfAddress: null,
  indexer: null,
  serverTime: null,
  chainHead: null,
  babeEpoch: null,
  babeAuthorities: [],
  chainMiners: [],
  recentDifficulty: [],
  loading: true,
  error: null,

  fetchTelemetry: async () => {
    // Only flash the loading screen on the very first load. Subsequent
    // polling refreshes leave the current UI visible and swap data in place.
    const firstLoad = get().blocks.length === 0 && get().nodes === null;
    if (firstLoad && !get().loading) set({ loading: true });
    try {
      const res = await fetch("/api/telemetry");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as TelemetryResponse;
      set({
        blocks: data.blocks,
        nodes: data.nodes,
        selfAddress: data.selfAddress ?? null,
        indexer: data.indexer ?? null,
        serverTime: data.serverTime ?? null,
        chainHead: data.chainHead ?? null,
        babeEpoch: data.babeEpoch ?? null,
        babeAuthorities: data.babeAuthorities ?? [],
        chainMiners: data.chainMiners ?? [],
        recentDifficulty: data.recentDifficulty ?? [],
        loading: false,
        error: null,
      });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : "Failed to load telemetry" });
    }
  },
}));

// --- Selectors ---

// Blocks arrive sorted ascending by (timestamp, block_index) — see
// api/db/sqlite.ts:211 and api/db/postgres.ts:181 — so the tip is the last
// element. Returns null when the store hasn't loaded any blocks yet.
//
// Returns a reference that's stable between fetches (same BlockRecord object
// in the array), so this is safe to pass directly to `useTelemetryStore(...)`.
// Don't layer a derived-object selector on top: zustand compares by reference
// and a fresh `{ epoch, blockIndex }` each call would loop forever.
export function selectTipBlock(s: TelemetryState): BlockRecord | null {
  return s.blocks.length > 0 ? (s.blocks[s.blocks.length - 1] ?? null) : null;
}

/** Timestamp (ms) of the tip block, or null when no blocks are loaded. */
export function selectTipBlockTimestampMs(s: TelemetryState): number | null {
  const tip = selectTipBlock(s);
  return tip ? tip.timestamp * 1000 : null;
}

/**
 * Server-anchored "now" in ms. Returns the parsed `serverTime` from the most
 * recent telemetry response, or `Date.now()` if no response has landed yet
 * (initial connect). Use this in place of `Date.now()` when computing ages
 * relative to indexer/server fields — fixes audit #3 (backgrounded tab shows
 * inflated heartbeat ages because the cached response's lastStatusFetchAt is
 * server-stamped but the comparison anchor was client-clock).
 */
export function selectServerNowMs(s: TelemetryState): number {
  if (s.serverTime === null) return Date.now();
  const parsed = Date.parse(s.serverTime);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
