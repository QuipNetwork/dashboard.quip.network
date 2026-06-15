// SPDX-License-Identifier: AGPL-3.0-or-later

import { create, type StateCreator } from "zustand";
import { HttpTelemetryClient, type TelemetryClient } from "../services/telemetry-client";
import type {
  BabeAuthorityRecord,
  BabeEpochState,
  BlockRecord,
  ChainHead,
  ChainMinerRecord,
  CurrentDispatch,
  DifficultyRecord,
  IndexerObservability,
  MiningSubmissionRecord,
  NodeDescriptorRecord,
  NodesSnapshot,
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
  // Snapshot of network nodes, projected server-side from chain-signed
  // `node_descriptors`. Null until the descriptor worker has observed at
  // least one valid `quip-miner identify` extrinsic.
  nodes: NodesSnapshot | null;
  // Per-account chain-signed descriptors with provenance. Drives the
  // Node Identities panel and the ChainMinersTable join on accountId.
  nodeDescriptors: NodeDescriptorRecord[];
  // Recent miner-side submissions for the locally polled miner. Drives
  // the "Recent Performance" panel; empty when the miner has not yet
  // submitted a proof (or selfAddress hasn't resolved on the indexer).
  recentMiningSubmissions: MiningSubmissionRecord[];
  // Lifetime count of self's distinct solution_numbers with iterations
  // recorded. Drives the "Problems Attempted" tile.
  selfProblemsAttempted: number;
  // The miner's most recent dispatch (in-flight if probe-ahead has
  // iterations, otherwise the just-completed one). Null when miner
  // hasn't dispatched or both probes failed. Drives the
  // "Current Attempts" panel above Mining Performance.
  currentDispatch: CurrentDispatch | null;
  loading: boolean;
  error: string | null;

  fetchTelemetry: () => Promise<void>;
}

export interface TelemetryStoreDeps {
  client: TelemetryClient;
}

const createTelemetryState =
  (deps: TelemetryStoreDeps): StateCreator<TelemetryState> =>
  (set, get) => ({
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
    nodes: null,
    nodeDescriptors: [],
    recentMiningSubmissions: [],
    selfProblemsAttempted: 0,
    currentDispatch: null,
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
        const data = await deps.client.fetchTelemetry();
        // Defensive coercion: a rolling deploy (or a stale dev-server that
        // hasn't been restarted past a schema bump) can return a response
        // missing newly-added fields. Without these defaults, downstream
        // hooks crash on `undefined.map` / `undefined.length` instead of
        // gracefully degrading to "no data yet".
        set({
          blocks: data.blocks ?? [],
          selfAddress: data.selfAddress ?? null,
          indexer: data.indexer ?? null,
          serverTime: data.serverTime,
          chainHead: data.chainHead ?? null,
          babeEpoch: data.babeEpoch ?? null,
          babeAuthorities: data.babeAuthorities ?? [],
          chainMiners: data.chainMiners ?? [],
          recentDifficulty: data.recentDifficulty ?? [],
          validators: data.validators ?? [],
          nodes: data.nodes ?? null,
          nodeDescriptors: data.nodeDescriptors ?? [],
          recentMiningSubmissions: data.recentMiningSubmissions ?? [],
          selfProblemsAttempted: data.selfProblemsAttempted ?? 0,
          currentDispatch: data.currentDispatch ?? null,
          loading: false,
          error: null,
        });
      } catch (e) {
        set({ loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
  });

export const createTelemetryStore = (deps: TelemetryStoreDeps) =>
  create<TelemetryState>(createTelemetryState(deps));

export const useTelemetryStore = createTelemetryStore({ client: new HttpTelemetryClient() });

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
