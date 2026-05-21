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
import type {
  BlockEvents,
  DifficultyInfo,
  SubstrateClient,
  SubstrateHead,
  TopologyInfo,
  UnsubFn,
} from "./substrate-client";

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
      try {
        await db.recordValidatorAuthorship(
          e.author,
          String(e.blockNumber),
          e.timestamp,
          e.winner !== null,
        );
      } catch (err) {
        console.warn(
          `[indexer/substrate] block #${e.blockNumber}: validator authorship write failed:`,
          err,
        );
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

      // Mining time: substrate-blocks since the previous winning proof.
      // Read LastProofBlock AT THE PARENT block hash; on_finalize
      // updates it in-block, so reading the parent gives us the prior
      // value to subtract from this block's number.
      const lastProofBlock = await client.getLastProofBlockAt(e.parentHash);
      const miningTime = lastProofBlock > 0 ? Math.max(1, e.blockNumber - lastProofBlock) : 0;

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
 * Walk `quantum_pow.WinningSolutions` storage to find historical winning
 * blocks that aren't in our local `blocks` table yet, then fetch and write
 * each through the same path the live subscription uses.
 *
 * Called once on every successful connect. With INSERT OR IGNORE
 * idempotency on `blocks.block_hash`, repeated runs over already-backfilled
 * blocks are no-ops; the work is bounded by the number of unique winning
 * blocks the chain has ever emitted, which is small (≤ chain height).
 */
async function backfillHistoricalWins(
  deps: SubstrateWorkerDeps,
  write: (e: BlockEvents) => Promise<void>,
): Promise<void> {
  const { client, db } = deps;
  const winning = await client.getWinningBlockNumbers();
  if (winning.length === 0) return;

  // Snapshot existing block numbers in one go. The store's rolling cap is
  // ~500 rows; chain-lifetime winners can exceed that, so we read a
  // generous chunk to avoid backfilling blocks we already have. Anything
  // beyond the chunk that's a duplicate is harmless — INSERT OR IGNORE.
  const existingNums = new Set(
    (await db.getRecentBlocks(10_000, 0)).map((b) => b.substrateBlockNumber),
  );
  const missing = winning.filter((n) => !existingNums.has(n)).sort((a, b) => Number(a) - Number(b));
  if (missing.length === 0) return;

  console.log(
    `[indexer/substrate] backfilling ${missing.length} historical winning blocks (of ${winning.length} total)`,
  );

  // Sequential walk to keep RPC pressure low. Each block requires a
  // getBlockHash + derive.chain.getBlock + timestamp.now.at + 1 runtime
  // API call — ~4 RPCs per missing block. A chain with 1000 historical
  // wins backfills in seconds.
  for (const n of missing) {
    try {
      const events = await client.processFinalizedBlock(n);
      if (events === null) {
        console.warn(`[indexer/substrate] backfill: block #${n} not found on chain; skipping`);
        continue;
      }
      await write(events);
    } catch (err) {
      console.warn(`[indexer/substrate] backfill: block #${n} failed:`, err);
    }
  }
}

interface PollIdempotencyCache {
  // Hash of (epochIndex, currentSlot) — bumped on every observed change.
  babeEpochHash: string | null;
  // Hash of (energy, diversity, solutions, quality) — bumped on every
  // observed change. Doubles as the dedupe key for insertDifficultySnapshot.
  difficultyHash: string | null;
  // Hash of the sorted (accountId,deposit,proofs,rewards) tuples — bumped
  // when any miner's on-chain state changes. Single hash for the whole set
  // since polling cadence is coarse (default 300s); a granular diff would
  // add complexity for no win.
  chainMinersHash: string | null;
  // Hash of (epochIndex + sorted authority account IDs).
  babeAuthoritiesHash: string | null;
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

  // currentSlotInEpoch via modulo. We can't subtract epochStartSlot because
  // BABE slots are absolute (include genesisSlot) — `epochIndex *
  // slotsPerEpoch` doesn't match the actual epoch boundary. Modulo gives
  // the correct in-epoch offset regardless of when the chain started, and
  // is bounded by slotsPerEpoch so it always fits in a small int.
  let currentSlotInEpoch = 0;
  try {
    currentSlotInEpoch = Number(BigInt(info.currentSlot) % BigInt(info.slotsPerEpoch));
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
 * (max_energy_milli, min_diversity_milli) into the "human" units the
 * dashboard's BlockRecord already uses.
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
  const hash = `${difficultyEnergy}:${minDiversity}:${info.minSolutions}`;
  if (hash === cache.difficultyHash) return;
  cache.difficultyHash = hash;

  await deps.db.insertDifficultySnapshot({
    observedAtBlock,
    difficultyEnergy,
    minDiversity,
    minSolutions: info.minSolutions,
    observedAt: nowIso(deps),
  });
}

/**
 * Poll the on-chain miner registry (`quantum_pow.Miners`) and the BABE
 * authority set (`session.validators`). Both share the same cadence
 * because they're chain-static enough that fine-grained timers add no
 * value — once per `substrateChainPollSec` is plenty.
 *
 * Authorities require a current BABE epoch in the cache to key on; if
 * the BABE poll hasn't completed yet (first connect window), the
 * authorities write is deferred to the next tick. Miners write
 * unconditionally — they're keyed by account ID, not by era.
 */
async function pollChainState(
  deps: SubstrateWorkerDeps,
  cache: PollIdempotencyCache,
): Promise<void> {
  const [miners, authorities, epoch] = await Promise.all([
    deps.client.getChainMiners(),
    deps.client.getBabeAuthorities(),
    deps.client.getBabeEpoch(),
  ]);

  // --- Miners ---
  // Sort by accountId so the hash is order-independent. Storage entries
  // come from a map and have no inherent ordering.
  const sortedMiners = [...miners].sort((a, b) =>
    a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0,
  );
  const minersHash = sortedMiners
    .map(
      (m) => `${m.accountId}:${m.deposit}:${m.proofsSubmitted}:${m.proofsWon}:${m.rewardsEarned}`,
    )
    .join("|");
  if (minersHash !== cache.chainMinersHash) {
    cache.chainMinersHash = minersHash;
    await deps.db.upsertChainMiners(
      sortedMiners.map((m) => ({
        accountId: m.accountId,
        deposit: m.deposit,
        proofsSubmitted: m.proofsSubmitted,
        proofsWon: m.proofsWon,
        rewardsEarned: m.rewardsEarned,
      })),
    );
  }

  // --- BABE authorities ---
  if (epoch) {
    const sortedAuthorities = [...authorities].sort((a, b) =>
      a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0,
    );
    const authoritiesHash = `${epoch.epochIndex}|${sortedAuthorities.map((a) => a.accountId).join(",")}`;
    if (authoritiesHash !== cache.babeAuthoritiesHash) {
      cache.babeAuthoritiesHash = authoritiesHash;
      await deps.db.upsertBabeAuthorities(epoch.epochIndex, sortedAuthorities);
    }
  }
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
