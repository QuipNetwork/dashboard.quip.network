// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Substrate worker (v0.3): the canonical block writer. Subscribes to
// quantum_pow's per-block (BlockWinner + ProofAccepted) event pairs via
// `subscribeBlockEvents` and writes one BlockRecord per finalized winning
// block. Also writes chain_head on every head event and polls BABE epoch,
// chain miners, BABE authorities, and difficulty snapshots on a cadence.
//
// Before v0.3 the substrate worker was an enrichment side-channel that
// filled in `substrate_*` columns on rows the tip worker had already
// written from REST telemetry. In v0.3 the chain is the sole source of
// per-block data — REST is identity+stats only — so this worker writes
// the full row at insert time, with no two-phase enrichment race.

import type { DatabaseAdapter } from "../api/db/adapter";
import type { BlockRecord } from "../src/types/telemetry";

import type { IndexerConfig } from "./config";
import type { IndexerState } from "./state";
import type { ChainSource } from "./sources";
import type {
  BlockEvents,
  DifficultyInfo,
  SubstrateHead,
  TopologyInfo,
  UnsubFn,
} from "./substrate-client";
import { backfillHistoricalWins } from "./substrate-worker-backfill";
import {
  pollBabeEpoch,
  pollChainState,
  pollDifficulty,
  type PollIdempotencyCache,
} from "./substrate-worker-polls";
import {
  BABE_SLOT_DURATION_SEC,
  CHAIN_HEAD_DEBOUNCE_DEFAULT_MS,
  backoffMs,
  nowIso,
  type ConnectedDeps,
} from "./substrate-worker-shared";

export interface SubstrateWorkerDeps {
  config: IndexerConfig;
  // Ordered fallback list. The worker round-robins through this on
  // connect failure so a single-endpoint outage falls over to the
  // next operator-configured RPC without dropping the indexer.
  urls: string[];
  // Builds a fresh SubstrateClient per connect attempt. Production
  // wraps `new PolkadotSubstrateClient(url, timeoutMs)`; tests return
  // a pre-canned FakeSubstrateClient ignoring `url`.
  clientFactory: (url: string) => ChainSource;
  db: DatabaseAdapter;
  state: IndexerState;
  // Test hook — defaults to Date.now(). Used for deterministic
  // lastSubstrateEventAt timestamps.
  now?: () => number;
  // Test hook — chain_head write debounce. Default 1000ms in prod; tests
  // override to 0 so a single event flushes immediately.
  chainHeadDebounceMs?: number;
}

/**
 * Connect-loop iteration: open the client, register all subscriptions,
 * keep the heartbeat fresh, then unwind cleanly on disconnect or abort.
 * Returns when the connection drops (caller retries with backoff) or the
 * abort signal fires (caller exits).
 */
async function runConnected(deps: ConnectedDeps, signal: AbortSignal): Promise<void> {
  const { client, db, state } = deps;

  await client.connect();
  state.observability.chainConnected = true;
  state.observability.lastSubstrateEventAt = nowIso(deps);

  // Disconnect handler — flip health off so SyncIndicator notices. The
  // outer loop drives reconnect.
  const disconnectedSignal = new AbortController();
  const offDisconnected = client.onDisconnected(() => {
    state.observability.chainConnected = false;
    disconnectedSignal.abort();
  });

  // Best/finalized head state, written via a 1-second debounce so a flurry
  // of new heads collapses to a single chain_head row write.
  let bestHead: SubstrateHead | null = null;
  let finalizedHead: SubstrateHead | null = null;
  let chainHeadTimer: ReturnType<typeof setTimeout> | null = null;
  const flushChainHead = async () => {
    // Need at least one head before writing chain_head. Substrate
    // guarantees finalized ≤ best, so when we only know one we can fill
    // the other with the known value: a fresh subscription that hasn't
    // seen the other event yet (common on connect) still produces a
    // valid row. Subsequent events refine the lag once both arrive.
    const known = bestHead ?? finalizedHead;
    if (!known) return;
    const best = bestHead ?? known;
    const finalized = finalizedHead ?? known;
    const rt = await client.getRuntimeVersion().catch((e) => {
      // Surface so the silent skip — which also skips the
      // bestBlockHeight/finalizedBlockHeight observability writes below —
      // doesn't disappear without a trace.
      console.warn(
        "[indexer/substrate] runtime version fetch failed; skipping chain_head write:",
        e instanceof Error ? e.message : e,
      );
      return null;
    });
    if (!rt) return;
    const lastUpgrade = await client.getLastRuntimeUpgrade().catch(() => null);
    // Chain-wide winning-solution count → the global solution_number bound
    // (MR !105). Best-effort: a failed/absent read leaves it null and the
    // mining-attempts catch-up simply skips a tick rather than poisoning
    // the chain_head write.
    const winningSolutionsCount = await client.getWinningSolutionsCount().catch(() => null);
    const bestN = best.number;
    const finN = finalized.number;
    const lag = (() => {
      try {
        return Number(BigInt(bestN) - BigInt(finN));
      } catch {
        return 0;
      }
    })();
    await db.upsertChainHead({
      bestBlockNumber: bestN,
      bestBlockHash: best.hash,
      finalizedBlockNumber: finN,
      finalizedBlockHash: finalized.hash,
      finalityLag: lag,
      winningSolutionsCount,
      runtime: {
        specName: rt.specName,
        specVersion: rt.specVersion,
        transactionVersion: rt.transactionVersion,
        implName: rt.implName,
        lastRuntimeUpgrade: lastUpgrade?.blockNumber ?? null,
      },
      updatedAt: nowIso(deps),
    });
    state.observability.bestBlockHeight = bestN;
    state.observability.finalizedBlockHeight = finN;
  };
  const debounceMs = deps.chainHeadDebounceMs ?? CHAIN_HEAD_DEBOUNCE_DEFAULT_MS;
  const scheduleChainHead = () => {
    if (chainHeadTimer) clearTimeout(chainHeadTimer);
    chainHeadTimer = setTimeout(() => {
      void flushChainHead().catch((e) => {
        console.warn("[indexer/substrate] chain_head write failed:", e);
      });
    }, debounceMs);
  };

  const unsubs: UnsubFn[] = [];

  unsubs.push(
    await client.subscribeNewHeads((h) => {
      bestHead = h;
      state.observability.lastSubstrateEventAt = nowIso(deps);
      scheduleChainHead();
    }),
  );

  unsubs.push(
    await client.subscribeFinalizedHeads((h) => {
      finalizedHead = h;
      state.observability.lastSubstrateEventAt = nowIso(deps);
      state.observability.finalizedBlockHeight = h.number;
      scheduleChainHead();
    }),
  );

  // --- Canonical block writer ---
  // Prime topology and difficulty before the first block event so the
  // writer has non-zero fallbacks if the per-block refreshes lag. Topology
  // changes infrequently enough that we don't refresh it per block;
  // difficulty refreshes on every block (cheap storage read).
  const cachedTopology = await client.getTopology().catch(() => null);
  const topology: TopologyInfo = cachedTopology ?? { nodeCount: 0, edgeCount: 0 };
  let lastDifficulty: DifficultyInfo | null = await client.getDifficulty().catch(() => null);

  // In-process dedup for validator authorship. `recordValidatorAuthorship`
  // is increment-by-1 (not idempotent on (account, block)), so a replayed
  // finalized head — from a reconnect, or the live sub racing with the
  // startup `backfillHistoricalWins` for the same block — would otherwise
  // double-count the author. Restart-scope is sufficient: across restarts
  // the `validator_authorship` row already exists, and the worker only
  // re-processes blocks it sees again within one connection's lifetime.
  const recordedAuthorship = new Set<string>();

  // Block-events writer. Used by both the live finalized-head subscription
  // and the startup historical backfill. Same shape, same writes —
  // backfilled rows look identical to live-captured rows. `db.insertBlock`
  // is INSERT OR IGNORE, so a backfilled block that races with a live
  // subscription firing on the same height is a no-op duplicate.
  const writeBlockEvents = async (e: BlockEvents): Promise<void> => {
    state.observability.lastSubstrateEventAt = nowIso(deps);

    // (1) Authorship is recorded for EVERY finalized head where the
    //     author is known, independent of the canonical block writer
    //     path below. The validator may have authored a head without
    //     a winning PoW proof; we still want to count it. Contained
    //     in its own try/catch so a transient adapter error here
    //     can't block the block-insert path that follows.
    if (e.author !== null) {
      const authorshipKey = `${e.author}|${e.blockNumber}`;
      if (!recordedAuthorship.has(authorshipKey)) {
        try {
          await db.recordValidatorAuthorship(
            e.author,
            String(e.blockNumber),
            e.timestamp,
            e.winner !== null,
          );
          recordedAuthorship.add(authorshipKey);
        } catch (err) {
          console.warn(
            `[indexer/substrate] block #${e.blockNumber}: validator authorship write failed:`,
            err,
          );
        }
      }
    }

    // (2) No BlockWinner: nothing more to do for the canonical block
    //     writer path. Authorship-only heads land here.
    if (e.winner === null) return;

    try {
      const winnerEvent = e.winner;
      // Correlate winner with its matching ProofAccepted by
      // (miner, energyMilli). The chain emits both events from
      // on_finalize for every winning proof, so a missing match means
      // a decode anomaly — skip rather than write a half-populated row.
      const winningProof = e.proofs.find(
        (p) => p.miner === winnerEvent.miner && p.energyMilli === winnerEvent.energyMilli,
      );
      if (!winningProof) {
        console.warn(
          `[indexer/substrate] block #${e.blockNumber}: BlockWinner without matching ProofAccepted; skipping insert`,
        );
        return;
      }

      // Nonce is null when extractNonce couldn't locate a matching
      // submit_proof extrinsic (transient decode anomaly). The
      // BlockRecord.nonce column is NOT NULL, and a "0" sentinel would
      // collide with the legitimate u64 value 0 — skip instead, parallel
      // to the missing-ProofAccepted skip above.
      const nonce = e.nonce;
      if (nonce === null) {
        console.warn(
          `[indexer/substrate] block #${e.blockNumber}: BlockWinner without recoverable submit_proof nonce; skipping insert`,
        );
        return;
      }

      // Mining time in SECONDS. Computed as (block-delta × BABE slot duration).
      // The block-delta is substrate-blocks since the previous winning proof;
      // LastProofBlock is read AT THE PARENT block hash because on_finalize
      // updates it in-block, so the parent's value is the prior tip.
      // Stored as seconds because every downstream consumer treats it as
      // such (chart axes "seconds", `formatDuration(miningTime * 1000)`).
      const lastProofBlock = await client.getLastProofBlockAt(e.parentHash);
      const miningTimeBlocks = lastProofBlock > 0 ? Math.max(1, e.blockNumber - lastProofBlock) : 0;
      const miningTime = miningTimeBlocks * BABE_SLOT_DURATION_SEC;

      // Per-block difficulty snapshot. v0.2 chain persists the exact
      // threshold each winning proof cleared in `WinningSolutions[N]`
      // — sourced via `QuantumPowApi::winning_solution(blockNumber)`.
      // Falls back to the most recent live `current_difficulty()` poll
      // for pre-v0.2 chains, then to zeros, so the writer never blocks
      // on missing per-block data.
      const winSol = await client.getWinningSolution(String(e.blockNumber)).catch(() => null);
      if (winSol?.difficulty) lastDifficulty = winSol.difficulty;
      const d: DifficultyInfo = winSol?.difficulty ??
        lastDifficulty ?? {
          maxEnergyMilli: 0,
          minDiversityMilli: 0,
          minSolutions: 0,
        };

      const record: BlockRecord = {
        blockHash: e.blockHash,
        substrateBlockNumber: String(e.blockNumber),
        substrateBlockHash: e.blockHash,
        substrateParentHash: e.parentHash,
        timestamp: e.timestamp,
        minerId: winnerEvent.miner,
        energy: winnerEvent.energyMilli / 1000,
        diversity: winningProof.diversityMilli / 1000,
        numValidSolutions: winningProof.validSolutionCount,
        miningTime,
        reward: winnerEvent.reward,
        nonce,
        numNodes: topology.nodeCount,
        numEdges: topology.edgeCount,
        difficultyEnergy: d.maxEnergyMilli / 1000,
        minDiversity: d.minDiversityMilli / 1000,
        minSolutions: d.minSolutions,
        finalized: true, // backfill operates on finalized history; subscribe is finalized-only
      };

      await db.insertBlock(record);
      state.observability.lastBlockInsertAt = nowIso(deps);
    } catch (err) {
      console.warn(`[indexer/substrate] block #${e.blockNumber} writer failed:`, err);
    }
  };

  unsubs.push(await client.subscribeBlockEvents(writeBlockEvents));

  // Startup backfill: for each block number recorded in the chain's
  // `quantum_pow.WinningSolutions` storage map but NOT yet in our local
  // `blocks` table, fetch and decode the block, then route through the
  // same writer. This recovers historical wins that fired before our
  // finalized-heads subscription started receiving events. Fire-and-forget
  // so a long backfill doesn't block live subscription wiring or
  // chain_head writes; ordering doesn't matter because each block's
  // mining_time is computed against the chain (LastProofBlock at parent),
  // not against the local insert order.
  void backfillHistoricalWins(deps, writeBlockEvents).catch((e) => {
    console.warn("[indexer/substrate] historical backfill failed:", e);
  });

  // --- Polling: BABE epoch + difficulty + (Phase 3) chain miners/authorities ---
  // Worker-level idempotency cache so polls that observe no change avoid
  // hitting the DB at all. The adapter is also idempotent (ON CONFLICT … WHERE
  // … IS DISTINCT FROM), so these are belt-and-suspenders.
  const pollState: PollIdempotencyCache = {
    babeEpochHash: null,
    difficultyHash: null,
    chainMinersHash: null,
    babeAuthoritiesHash: null,
  };

  // Initial polls on connect — populate UI before the first timer tick.
  void pollBabeEpoch(deps, pollState).catch((e) => {
    console.warn("[indexer/substrate] initial babe-epoch poll failed:", e);
  });
  void pollDifficulty(deps, pollState).catch((e) => {
    console.warn("[indexer/substrate] initial difficulty poll failed:", e);
  });
  void pollChainState(deps, pollState).catch((e) => {
    console.warn("[indexer/substrate] initial chain-state poll failed:", e);
  });

  const babeTimer = setInterval(() => {
    void pollBabeEpoch(deps, pollState).catch((e) => {
      console.warn("[indexer/substrate] babe-epoch poll failed:", e);
    });
  }, deps.config.substrateBabePollSec * 1000);

  const chainPollTimer = setInterval(() => {
    void pollDifficulty(deps, pollState).catch((e) => {
      console.warn("[indexer/substrate] difficulty poll failed:", e);
    });
    void pollChainState(deps, pollState).catch((e) => {
      console.warn("[indexer/substrate] chain-state poll failed:", e);
    });
  }, deps.config.substrateChainPollSec * 1000);

  try {
    // Wait until either the abort fires (operator shutdown) or the
    // disconnect handler trips (chain dropped us).
    await new Promise<void>((resolve) => {
      const onAbort = () => resolve();
      signal.addEventListener("abort", onAbort, { once: true });
      disconnectedSignal.signal.addEventListener("abort", onAbort, { once: true });
    });
  } finally {
    if (chainHeadTimer) clearTimeout(chainHeadTimer);
    clearInterval(babeTimer);
    clearInterval(chainPollTimer);
    for (const u of unsubs) {
      try {
        u();
      } catch {
        // Best-effort unsubscribe during shutdown.
      }
    }
    offDisconnected();
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
    state.observability.chainConnected = false;
  }
}

/**
 * Main entry point. Drives an outer reconnect loop around `runConnected`.
 * Non-fatal at every layer — failures are logged and the loop retries
 * with exponential backoff. On each retry the next URL in `deps.urls` is
 * picked (round-robin) so a single bad endpoint falls over to the rest
 * of the operator-configured list. The indexer's REST workers keep
 * running regardless of substrate health.
 */
export async function runSubstrateLoop(
  deps: SubstrateWorkerDeps,
  signal: AbortSignal,
): Promise<void> {
  const { config, urls, clientFactory } = deps;
  if (urls.length === 0) {
    throw new Error("[indexer/substrate] urls list is empty; cannot connect");
  }
  let attempt = 0;
  let urlIdx = 0;
  while (!signal.aborted) {
    const url = urls[urlIdx]!;
    const client = clientFactory(url);
    const connectedDeps: ConnectedDeps = {
      config,
      client,
      db: deps.db,
      state: deps.state,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.chainHeadDebounceMs !== undefined
        ? { chainHeadDebounceMs: deps.chainHeadDebounceMs }
        : {}),
    };
    try {
      await runConnected(connectedDeps, signal);
      // Successful run → reset the attempt counter but keep the same
      // URL on the next iteration (we'd return here only on disconnect
      // or abort; staying on the same URL avoids churn during a
      // transient drop on the primary endpoint).
      attempt = 0;
    } catch (e) {
      if (signal.aborted) return;
      if (attempt === 0) {
        // First failure log is informative; subsequent retries log
        // only every minute via the backoff cap.
        console.warn(
          `[indexer/substrate] connection to ${url} failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      attempt++;
      // Rotate to next URL on each failure. Single-URL lists fall back
      // to the same endpoint, mirroring prior behaviour.
      urlIdx = (urlIdx + 1) % urls.length;
    }
    if (signal.aborted) return;
    const sleep = backoffMs(attempt, config.substrateReconnectMaxBackoffMs);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, sleep);
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
