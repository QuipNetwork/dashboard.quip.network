// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, useContext } from "react";
import { createStore, useStore, type StateCreator, type StoreApi } from "zustand";
import { telemetryClient, type TelemetryClient } from "@/services/telemetry-client";
import type {
  BabeAuthorityRecord,
  BabeEpochState,
  BlockRecord,
  ChainHead,
  ChainMinerRecord,
  CurrentDispatch,
  DifficultyRecord,
  IndexerObservability,
  MineableTopologyRecord,
  MiningSubmissionRecord,
  NodeDescriptorRecord,
  NodesSnapshot,
  ParticipationComputeRow,
  ValidatorAuthorshipRecord,
} from "@quip/shared/telemetry";

export interface TelemetryState {
  // Every winner block known so far, from the qblock manifest and the qblock
  // files it lists. DESC by substrate block number. Grows as qblock history
  // loads, uncapped.
  wonBlocks: BlockRecord[];
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
  // Current per-topology difficulty for the chain's mineable whitelist.
  // Empty until the substrate worker observes a topology. Drives the
  // Mineable Topologies panel on the Chain view.
  mineableTopologies: MineableTopologyRecord[];
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
  // Participant-level compute facts (one row per qblock × participant, all
  // device kinds) for the server's recent window. Reduced by
  // aggregateParticipationByCategory / aggregateParticipationByQblock to drive
  // the Total-Compute pie and Mining-per-QBlock charts. Empty until the
  // indexer has recorded participation for an in-window qblock.
  participationCompute: ParticipationComputeRow[];
  loading: boolean;
  error: string | null;

  fetchTelemetry: () => Promise<void>;
}

export interface TelemetryStoreDeps {
  client: TelemetryClient;
}

const createTelemetryState =
  (deps: TelemetryStoreDeps): StateCreator<TelemetryState> =>
  (set, get) => {
    // Older qblock history loads one day at a time in the background after
    // the first render. A failed walk stops; the next poll resumes it from
    // the days the client has not loaded.
    let historyLoading = false;
    // Winners from the qblock files loaded so far; kept across polls so a
    // failed manifest fetch does not drop the loaded history.
    let fileWinners: BlockRecord[] = [];
    const loadQblockHistory = async (days: readonly string[]): Promise<void> => {
      historyLoading = true;
      try {
        for (const day of days) {
          const { rows, winners } = await deps.client.fetchQblockHistoryDay(day);
          fileWinners = winners;
          const wonBlocks = sortWinnersDesc(fileWinners);
          set({
            participationCompute: rows,
            wonBlocks,
          });
        }
      } catch (e) {
        console.warn("qblock history fetch failed", e);
      } finally {
        historyLoading = false;
      }
    };
    return {
      wonBlocks: [],
      selfAddress: null,
      indexer: null,
      serverTime: null,
      chainHead: null,
      babeEpoch: null,
      babeAuthorities: [],
      chainMiners: [],
      recentDifficulty: [],
      mineableTopologies: [],
      validators: [],
      nodes: null,
      nodeDescriptors: [],
      recentMiningSubmissions: [],
      selfProblemsAttempted: 0,
      currentDispatch: null,
      participationCompute: [],
      loading: true,
      error: null,
      fetchTelemetry: async () => {
        // Only flash the loading screen on the very first load. Subsequent
        // polling refreshes leave the current UI visible and swap data in place.
        // In steady state both wonBlocks and selfAddress are populated, so this
        // never re-enters the loading flash after the first successful fetch.
        const firstLoad = get().wonBlocks.length === 0 && get().selfAddress === null;
        if (firstLoad && !get().loading) set({ loading: true });
        try {
          const data = await deps.client.fetchTelemetry();
          // Participation facts are file-backed. A failed or timed-out manifest
          // keeps the rows from the last good poll rather than blanking the
          // charts: a blank chart reads as "zero participation", which is a
          // worse lie than slightly stale numbers. The block tables fed by the
          // same document already behave this way through `fileWinners`.
          let participationCompute: ParticipationComputeRow[] = get().participationCompute;
          // Every file this poll needs depends only on `data.files`, so they all
          // go out together and first paint pays one round trip, not three. The
          // nodes and dispatch documents degrade to null on failure; a 404 on
          // either (the writer has not run yet) must not fail the poll.
          const manifest = data.files?.qblocksManifest;
          const nodesUrl = data.files?.nodesSnapshot;
          const dispatchUrl = data.files?.minerCurrentDispatch;
          const [qblockSnapshot, nodesDoc, dispatchDoc] = await Promise.all([
            manifest
              ? deps.client.fetchQblocks(manifest).catch((e: unknown) => {
                  // fetchQblocks throws on a non-ok manifest, and an unhandled
                  // throw here would reject the whole batch. Best-effort: a 404
                  // (indexer hasn't written files yet) degrades to "no data yet".
                  console.warn("qblock file fetch failed", e);
                  return null;
                })
              : Promise.resolve(null),
            nodesUrl ? deps.client.fetchNodesSnapshot(nodesUrl) : Promise.resolve(null),
            dispatchUrl
              ? deps.client.fetchMinerCurrentDispatch(dispatchUrl)
              : Promise.resolve(null),
          ]);
          if (qblockSnapshot) {
            participationCompute = qblockSnapshot.rows;
            fileWinners = qblockSnapshot.winners;
            if (!historyLoading && qblockSnapshot.history.length > 0) {
              void loadQblockHistory(qblockSnapshot.history);
            }
          }
          // Defensive coercion: a rolling deploy (or a stale dev-server that
          // hasn't been restarted past a schema bump) can return a response
          // missing newly-added fields. Without these defaults, downstream
          // hooks crash on `undefined.map` / `undefined.length` instead of
          // gracefully degrading to "no data yet".
          // Winner blocks come from the qblock files. `fileWinners` persists
          // across polls, so a failed manifest fetch keeps the blocks already
          // loaded. The sort and dedupe are applied here because the file
          // walk guarantees neither.
          const wonBlocks = sortWinnersDesc(fileWinners);
          set({
            wonBlocks,
            selfAddress: data.selfAddress ?? null,
            indexer: data.indexer ?? null,
            serverTime: data.serverTime,
            chainHead: data.chainHead ?? null,
            babeEpoch: data.babeEpoch ?? null,
            babeAuthorities: data.babeAuthorities ?? [],
            chainMiners: data.chainMiners ?? [],
            recentDifficulty: data.recentDifficulty ?? [],
            mineableTopologies: data.mineableTopologies ?? [],
            validators: data.validators ?? [],
            // The nodes document is file-backed. Keep the last good copy across
            // polls so a transient 404 does not blank the network views.
            nodes: nodesDoc?.nodes ?? get().nodes,
            nodeDescriptors: nodesDoc?.nodeDescriptors ?? get().nodeDescriptors,
            recentMiningSubmissions: data.recentMiningSubmissions ?? [],
            selfProblemsAttempted: data.selfProblemsAttempted ?? 0,
            // Same rule as `nodes` above: a missing or timed-out dispatch file
            // keeps the last one rather than emptying the Current Attempts
            // panel on a single slow response.
            currentDispatch: dispatchDoc ?? get().currentDispatch,
            participationCompute,
            loading: false,
            error: null,
          });
        } catch (e) {
          set({ loading: false, error: e instanceof Error ? e.message : String(e) });
        }
      },
    };
  };

// Deduplicate winner blocks by hash and sort DESC by substrate block number.
// The qblock file walk guarantees neither, and the block tables rely on both.
export function sortWinnersDesc(winners: readonly BlockRecord[]): BlockRecord[] {
  const byHash = new Map<string, BlockRecord>();
  for (const block of winners) byHash.set(block.blockHash, block);
  return [...byHash.values()].sort((a, b) => {
    const left = BigInt(a.substrateBlockNumber);
    const right = BigInt(b.substrateBlockNumber);
    return left === right ? 0 : left > right ? -1 : 1;
  });
}

export const createTelemetryStore = (deps: TelemetryStoreDeps): StoreApi<TelemetryState> =>
  createStore<TelemetryState>(createTelemetryState(deps));

export const telemetryStore = createTelemetryStore({ client: telemetryClient });

export const TelemetryStoreContext = createContext<StoreApi<TelemetryState>>(telemetryStore);

const identity = <T>(state: T): T => state;

function useTelemetryStoreBase<T = TelemetryState>(
  selector: (state: TelemetryState) => T = identity as (state: TelemetryState) => T,
): T {
  return useStore(useContext(TelemetryStoreContext), selector);
}

export const useTelemetryStore: typeof useTelemetryStoreBase & StoreApi<TelemetryState> =
  Object.assign(useTelemetryStoreBase, telemetryStore);

// --- Selectors ---

/**
 * Server-anchored "now" in ms: the parsed `serverTime` from the most recent
 * telemetry response, or `Date.now()` if none has landed yet (initial
 * connect). Use in place of `Date.now()` when computing ages relative to
 * indexer/server fields — fixes audit #3 (backgrounded tab shows inflated
 * heartbeat ages because the cached response's lastStatusFetchAt is
 * server-stamped but the comparison anchor was client-clock).
 *
 * Takes the `serverTime` STRING, not the store state, precisely so it can't be
 * passed to `useTelemetryStore()` as a selector: the `Date.now()` fallback
 * returns a fresh number every call, and a store selector that returns an
 * unstable value loops `useSyncExternalStore` forever when serverTime is null
 * (bead mrt). Subscribe to the stable string and call this in render via
 * {@link useServerNowMs}.
 */
export const resolveServerNowMs = (serverTime: string | null): number =>
  serverTime ? Date.parse(serverTime) : Date.now();

/** Server-anchored "now" hook — see {@link resolveServerNowMs}. */
export function useServerNowMs(): number {
  return resolveServerNowMs(useTelemetryStore((s) => s.serverTime));
}

/**
 * The tip block, or null when no blocks are loaded. `sortWinnersDesc` sorts
 * `wonBlocks` DESC by substrate block number, so the tip is the first
 * element. Returns a reference
 * stable between fetches (same BlockRecord identity in the array), so it's
 * safe to pass directly to `useTelemetryStore(selectTipBlock)`. Don't layer a
 * derived-object selector on top: zustand compares by reference and a fresh
 * `{ ...fields }` each call would loop forever.
 */
export const selectTipBlock = (s: TelemetryState): BlockRecord | null =>
  s.wonBlocks.length > 0 ? (s.wonBlocks[0] ?? null) : null;

/** Timestamp (ms) of the tip block, or null when no blocks are loaded. */
export const selectTipBlockTimestampMs = (s: TelemetryState): number | null => {
  const tip = selectTipBlock(s);
  return tip ? tip.timestamp * 1000 : null;
};
