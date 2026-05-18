import { create } from "zustand";
import type {
  BabeAuthorityRecord,
  BabeEpochState,
  BlockRecord,
  ChainHead,
  ChainMinerRecord,
  DifficultyRecord,
  EpochStatus,
  IndexerObservability,
  NodesSnapshot,
  TelemetryIndex,
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
  // Epoch catalog with per-epoch status ("live" | "stale_fork"). Fetched
  // alongside /api/telemetry so the EpochSelector can accurately label
  // entries without conflating "past canonical" with "stale_fork"
  // (audit fix #2).
  telemetryIndex: TelemetryIndex | null;
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
  telemetryIndex: null,
  loading: true,
  error: null,

  fetchTelemetry: async () => {
    // Only flash the loading screen on the very first load. Subsequent
    // polling refreshes leave the current UI visible and swap data in place.
    const firstLoad = get().blocks.length === 0 && get().nodes === null;
    if (firstLoad && !get().loading) set({ loading: true });
    try {
      // Parallel fetch: /api/telemetry carries blocks + nodes + chain state,
      // /api/telemetry/index carries the epoch catalog with per-epoch
      // status. Both reads hit the same DB so server-side cost is tiny;
      // the SPA gets atomic-ish snapshots since they're requested together.
      const [telemetryRes, indexRes] = await Promise.all([
        fetch("/api/telemetry"),
        fetch("/api/telemetry/index"),
      ]);
      if (!telemetryRes.ok) throw new Error(`HTTP ${telemetryRes.status}`);
      const data = (await telemetryRes.json()) as TelemetryResponse;
      // Index failures are non-fatal — the EpochSelector falls back to
      // unlabeled entries when telemetryIndex is null.
      const index = indexRes.ok ? ((await indexRes.json()) as TelemetryIndex) : null;
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
        telemetryIndex: index,
        loading: false,
        error: null,
      });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : "Failed to load telemetry" });
    }
  },
}));

/**
 * Build an epoch → status map from a TelemetryIndex. Callers should pass
 * the raw `telemetryIndex` from the store and memoize this with `useMemo`
 * — returning a fresh Map from a Zustand selector causes infinite render
 * loops (the new reference looks like a state change every poll).
 */
export function buildEpochStatusMap(index: TelemetryIndex | null): Map<string, EpochStatus> {
  const map = new Map<string, EpochStatus>();
  for (const e of index?.epochs ?? []) map.set(e.epoch, e.status);
  return map;
}

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
