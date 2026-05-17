// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Substrate worker (Phase 1 MVP): subscribes to chain head, finality, and
// quantum_pow.BlockWinner events on a quip-protocol-rs validator. Enriches
// the existing PoW BlockRecord rows with substrate-side metadata, writes
// chain_head, and surfaces health into IndexerObservability for the
// SyncIndicator.
//
// Phase 2/3 add periodic polling of BABE epoch state, chain miners,
// validator set, and difficulty history. This file's `runSubstrateLoop`
// is shaped to host those polls inline — set up in Task 1.5, populated
// in 2.1 / 2.2 / 3.1 / 3.2.

import type { DatabaseAdapter } from "../api/db/adapter";

import type { IndexerConfig } from "./config";
import { IndexerState, type PendingWinnerEvent, type WinnerKey } from "./state";
import type { BlockWinnerEvent, SubstrateClient, SubstrateHead, UnsubFn } from "./substrate-client";

export interface SubstrateWorkerDeps {
  config: IndexerConfig;
  client: SubstrateClient;
  db: DatabaseAdapter;
  state: IndexerState;
  // Test hook — defaults to Date.now(). Used for deterministic
  // lastSubstrateEventAt timestamps.
  now?: () => number;
  // Test hook — chain_head write debounce. Default 1000ms in prod; tests
  // override to 0 so a single event flushes immediately.
  chainHeadDebounceMs?: number;
}

const CHAIN_HEAD_DEBOUNCE_DEFAULT_MS = 1000;

function nowIso(deps: SubstrateWorkerDeps): string {
  return new Date((deps.now ?? Date.now)()).toISOString();
}

function backoffMs(attempt: number, capMs: number): number {
  // Exponential with ±20% jitter. attempt 0 → ~1s, 1 → ~2s, …, capped.
  const base = Math.min(1000 * 2 ** attempt, capMs);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, base + jitter);
}

/**
 * Mark every block whose substrate_block_number is ≤ finalizedNumber as
 * finalized. Single statement — concurrency-safe since `finalized` is
 * monotonic (only sets, never clears).
 */
async function markFinalizedThrough(
  db: DatabaseAdapter,
  finalizedNumber: string,
): Promise<void> {
  // The adapter's updateBlockSubstrateFields is per-row; finality is a
  // bulk operation. Use a direct query via the adapter's internal API
  // would couple to adapter internals. Instead we walk pending rows
  // through a single query using getAllBlocks() filtered in memory —
  // acceptable for the dashboard's block volumes (~10s of thousands at
  // most). For larger scales, add a bulk markFinalized adapter method.
  const blocks = await db.getAllBlocks();
  const target = BigInt(finalizedNumber);
  for (const b of blocks) {
    if (b.finalized) continue;
    if (b.substrateBlockNumber == null) continue;
    try {
      if (BigInt(b.substrateBlockNumber) <= target) {
        await db.updateBlockSubstrateFields(b.epoch, b.blockIndex, { finalized: true });
      }
    } catch {
      // Skip rows whose substrate_block_number doesn't parse — they were
      // never enriched (or carry corrupt data).
    }
  }
}

/**
 * Enqueue a BlockWinner event whose matching PoW block hasn't landed yet.
 * Bounded LRU: when full, drops the oldest entry via Map insertion order.
 */
function bufferWinnerEvent(state: IndexerState, ev: PendingWinnerEvent): void {
  const limit = IndexerState.PENDING_WINNER_LIMIT;
  const key: WinnerKey = `${ev.miner}:${ev.energy}`;
  // Refresh insertion order if already present.
  if (state.pendingWinnerEvents.has(key)) state.pendingWinnerEvents.delete(key);
  state.pendingWinnerEvents.set(key, ev);
  while (state.pendingWinnerEvents.size > limit) {
    const oldest = state.pendingWinnerEvents.keys().next().value;
    if (oldest === undefined) break;
    state.pendingWinnerEvents.delete(oldest);
  }
}

/**
 * Connect-loop iteration: open the client, register all subscriptions,
 * keep the heartbeat fresh, then unwind cleanly on disconnect or abort.
 * Returns when the connection drops (caller retries with backoff) or the
 * abort signal fires (caller exits).
 */
async function runConnected(deps: SubstrateWorkerDeps, signal: AbortSignal): Promise<void> {
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
    const rt = await client.getRuntimeVersion().catch(() => null);
    if (!rt) return;
    const lastUpgrade = await client.getLastRuntimeUpgrade().catch(() => null);
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
      // Async finality flip — don't block the subscription callback.
      void markFinalizedThrough(db, h.number).catch((e) => {
        console.warn("[indexer/substrate] markFinalizedThrough failed:", e);
      });
    }),
  );

  unsubs.push(
    await client.subscribeBlockWinnerEvents((ev: BlockWinnerEvent) => {
      state.observability.lastSubstrateEventAt = nowIso(deps);
      void enrichOnBlockWinner(deps, ev).catch((e) => {
        console.warn("[indexer/substrate] BlockWinner enrichment failed:", e);
      });
    }),
  );

  // --- Polling: BABE epoch + difficulty + (Phase 3) chain miners/authorities ---
  // Worker-level idempotency cache so polls that observe no change avoid
  // hitting the DB at all. The adapter is also idempotent (ON CONFLICT … WHERE
  // … IS DISTINCT FROM), so these are belt-and-suspenders.
  const pollState: PollIdempotencyCache = {
    babeEpochHash: null,
    difficultyHash: null,
  };

  // Initial polls on connect — populate UI before the first timer tick.
  void pollBabeEpoch(deps, pollState).catch((e) => {
    console.warn("[indexer/substrate] initial babe-epoch poll failed:", e);
  });
  void pollDifficulty(deps, pollState).catch((e) => {
    console.warn("[indexer/substrate] initial difficulty poll failed:", e);
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

interface PollIdempotencyCache {
  // Hash of (epochIndex, currentSlot) — bumped on every observed change.
  babeEpochHash: string | null;
  // Hash of (energy, diversity, solutions, quality) — bumped on every
  // observed change. Doubles as the dedupe key for insertDifficultySnapshot.
  difficultyHash: string | null;
}

/**
 * Poll BABE epoch state. Skips the DB write when (epochIndex, currentSlot)
 * matches the last observed values — saves a transaction per uneventful
 * tick. Capability-checked (Fake / chains without BABE return null).
 */
async function pollBabeEpoch(
  deps: SubstrateWorkerDeps,
  cache: PollIdempotencyCache,
): Promise<void> {
  const info = await deps.client.getBabeEpoch();
  if (!info) return;
  const hash = `${info.epochIndex}:${info.currentSlot}`;
  if (hash === cache.babeEpochHash) return;
  cache.babeEpochHash = hash;

  // currentSlotInEpoch = currentSlot - epochStartSlot. Slots can exceed
  // Number.MAX_SAFE_INTEGER on long-running chains, but the delta within
  // one epoch (≤ slotsPerEpoch = 2400 on quip-protocol-rs spec 101) fits
  // in a small integer.
  let currentSlotInEpoch = 0;
  try {
    currentSlotInEpoch = Number(BigInt(info.currentSlot) - BigInt(info.epochStartSlot));
  } catch {
    // Malformed slot values — leave at 0 rather than throw; the BABE
    // progress bar will show empty until the next poll lands clean data.
  }

  await deps.db.upsertBabeEpoch({
    epochIndex: info.epochIndex,
    currentSlot: info.currentSlot,
    epochStartSlot: info.epochStartSlot,
    slotsPerEpoch: info.slotsPerEpoch,
    currentSlotInEpoch,
    authorityCount: info.authorityCount,
  });
}

/**
 * Poll `quantum_pow.Difficulty` and append a row to `difficulty_history`
 * when the snapshot has changed. Converts chain's milli-encoded floats
 * (max_energy_milli, min_diversity_milli, min_quality_milli) into the
 * "human" units the dashboard's BlockRecord already uses.
 *
 * `observed_at_block` is the substrate finalized height we know at poll
 * time. When the chain hasn't emitted a finalized head yet
 * (finalizedBlockHeight=null), we skip — there's no meaningful block to
 * anchor the snapshot to.
 */
async function pollDifficulty(
  deps: SubstrateWorkerDeps,
  cache: PollIdempotencyCache,
): Promise<void> {
  const info = await deps.client.getDifficulty();
  if (!info) return;
  const observedAtBlock = deps.state.observability.finalizedBlockHeight;
  if (observedAtBlock === null) return;
  // Convert milli → float (the dashboard's BlockRecord uses floats; chain
  // stores u32/i64 milli-encodings to avoid floating-point in consensus).
  const difficultyEnergy = info.maxEnergyMilli / 1000;
  const minDiversity = info.minDiversityMilli / 1000;
  const minQuality = info.minQualityMilli / 1000;
  const hash = `${difficultyEnergy}:${minDiversity}:${info.minSolutions}:${minQuality}`;
  if (hash === cache.difficultyHash) return;
  cache.difficultyHash = hash;

  await deps.db.insertDifficultySnapshot({
    observedAtBlock,
    difficultyEnergy,
    minDiversity,
    minSolutions: info.minSolutions,
    minQuality,
    observedAt: nowIso(deps),
  });
}

/**
 * Enrich the PoW BlockRecord that matches this BlockWinner event. If the
 * REST side hasn't landed the block yet, buffer the enrichment so the
 * tip worker can replay it after insertBlock.
 */
async function enrichOnBlockWinner(
  deps: SubstrateWorkerDeps,
  ev: BlockWinnerEvent,
): Promise<void> {
  const { client, db, state } = deps;
  const energy = ev.energyMilli / 1000;

  // Look up the substrate header up front; cache it for either the
  // immediate update path or the buffered drain path.
  const header = await client.getBlockHeader(ev.submittedAt);
  if (!header) {
    // Chain didn't return a header for this block number — log once and
    // skip rather than buffering. Submitted_at should always resolve;
    // if it doesn't, the event is malformed.
    console.warn(`[indexer/substrate] no header for submittedAt=${ev.submittedAt}; skipping`);
    return;
  }

  const fields = {
    substrateBlockNumber: ev.submittedAt,
    substrateBlockHash: header.hash,
    substrateParentHash: header.parentHash,
    extrinsicsRoot: header.extrinsicsRoot,
    stateRoot: header.stateRoot,
  };

  const match = await db.findBlockByMinerAndEnergy(ev.miner, energy);
  if (!match) {
    bufferWinnerEvent(state, {
      miner: ev.miner,
      energy,
      submittedAt: ev.submittedAt,
      substrateBlockHash: header.hash,
      substrateParentHash: header.parentHash,
      extrinsicsRoot: header.extrinsicsRoot,
      stateRoot: header.stateRoot,
    });
    return;
  }
  await db.updateBlockSubstrateFields(match.epoch, match.blockIndex, fields);
}

/**
 * Main entry point. Drives an outer reconnect loop around `runConnected`.
 * Non-fatal at every layer — failures are logged and the loop retries
 * with exponential backoff. The indexer's REST workers keep running
 * regardless of substrate health.
 */
export async function runSubstrateLoop(
  deps: SubstrateWorkerDeps,
  signal: AbortSignal,
): Promise<void> {
  const { config } = deps;
  let attempt = 0;
  while (!signal.aborted) {
    try {
      await runConnected(deps, signal);
      attempt = 0;
      // runConnected only returns on signal abort or chain disconnect.
      // The outer while-loop handles the reconnect.
    } catch (e) {
      if (signal.aborted) return;
      if (attempt === 0) {
        // First failure log is informative; subsequent retries log
        // only every minute via the backoff cap.
        console.warn(
          `[indexer/substrate] connection to ${config.substrateRpcUrl} failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      attempt++;
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
