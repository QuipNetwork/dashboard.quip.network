// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseAdapter } from "../api/db/adapter";
import { MiningSubmissionNotFoundError } from "../api/miner-api";
import { resolveSelfMinerRestUrl } from "../api/resolve-miner-rest";
import type { MinerCategory, MinerHardwareRecord, MinerStats } from "../src/types/telemetry";

import type { IndexerConfig } from "./config";
import { QuipClient } from "./client";
import { IndexerState } from "./state";

// Cap on per-poll submission fetches. The global solution_number space is
// dense from this miner's view (every miner grinds the same solutions), so
// catch-up walks contiguously; 25 per tick bounds the work without starving
// the loop — at the default 5s cadence that's 300 solutions/minute, well
// above realistic win rates.
const MINING_ATTEMPTS_PER_POLL_CAP = 25;

// How far below the current global solution_number to seed the checkpoint on
// first contact (or after long downtime). The miner only has directories for
// solution_numbers it was online for, and the UI backfills older self-wins
// from chain blocks anyway, so there's no point grinding thousands of ancient
// numbers that predate this miner — we only need a recent, screenful-plus
// window of live miner-side rows.
const MINING_ATTEMPTS_BACKFILL_WINDOW = 200;

/**
 * Per-iteration dependencies used by {@link runTipIteration}. The loop
 * (below) resolves the miner-REST URL up-front and constructs the client;
 * tests can call `runTipIteration` directly with a fake client.
 */
export interface TipIterationDeps {
  client: QuipClient;
  db: DatabaseAdapter;
  state: IndexerState;
  now?: () => number;
}

/**
 * Long-running loop dependencies. Compared to {@link TipIterationDeps},
 * this owns the responsibility of resolving the local operator's
 * miner-REST URL per iteration. The factory pattern keeps production
 * wiring (`new QuipClient(...)`) and test wiring (return a pre-canned
 * fake) symmetric.
 */
export interface TipWorkerDeps {
  config: IndexerConfig;
  db: DatabaseAdapter;
  state: IndexerState;
  clientFactory: (baseUrl: string) => QuipClient;
  now?: () => number;
}

/**
 * Drive {@link runTipIteration} on a fixed cadence until the abort signal
 * fires. Each iteration:
 *   1. Read the cached operator SS58 from `db.getSelfAddress()` — the
 *      authoritative identity, written by prior /api/v1/status polls
 *      and surfaced everywhere in the UI (leaderboard, MyNode, etc.).
 *   2. Resolve the miner-REST base URL from the descriptor table (or
 *      the validator RPC URL fallback when no descriptor row exists
 *      yet).
 *   3. If a URL resolves, construct a {@link QuipClient} and run a
 *      full iteration. Otherwise flush the heartbeat alone so the UI
 *      can distinguish "indexer dead" from "indexer running without a
 *      miner to talk to yet".
 *
 * On a fresh DB `selfAddress` is null. The loop still resolves a URL
 * from the validator-RPC fallback (best-effort substitution), polls
 * /api/v1/status against it, and lets the iteration's `setSelfAddress`
 * write the answer — bootstrapping identity from the miner's own
 * response. From then on db.getSelfAddress() is the source of truth.
 *
 * Errors inside an iteration are logged and the loop continues — a
 * single bad poll doesn't kill the worker. No auth-fatal short-circuit:
 * REST access control is now a deployment concern (reverse-proxy auth),
 * not the indexer's.
 */
export async function runTipLoop(deps: TipWorkerDeps, signal: AbortSignal): Promise<void> {
  const intervalMs = deps.config.pollIntervalSec * 1000;
  while (!signal.aborted) {
    try {
      // Identity comes ONLY from local network access: poll the co-located
      // miner's /api/v1/status through the configured front door, which
      // back-fills selfAddress (see runTipIteration). We never probe on-chain
      // descriptors to find "self" — a reachable global node is not us, and
      // adopting one would mis-identify this deployment. If the local miner is
      // unreachable we warn and leave selfAddress null rather than guessing.
      const baseUrl = resolveSelfMinerRestUrl(deps.config.validatorRpcUrls);
      if (baseUrl) {
        const client = deps.clientFactory(baseUrl);
        await runTipIteration({ client, db: deps.db, state: deps.state, now: deps.now });
        if (!(await deps.db.getSelfAddress())) {
          console.warn(
            `[indexer/tip] could not identify this node: local miner REST ${baseUrl}/api/v1 ` +
              `is unreachable or returned no ss58. Check that the miner is running and that ` +
              `Caddy fronts /api/v1. Not falling back to a network node.`,
          );
        }
      } else {
        // No front door configured — keep the heartbeat fresh so the UI's
        // SyncIndicator knows the indexer process is alive.
        await flushHeartbeat(deps);
      }
    } catch (e) {
      console.error("[indexer/tip] iteration failed:", e instanceof Error ? e.message : e);
    }
    if (deps.config.once) return;
    await sleep(intervalMs, signal);
  }
}

/**
 * One poll: fetch /api/v1/status → upsert self miner_hardware + selfAddress
 * + chainHeadFromNode; fetch /api/v1/stats → cache minerStats. Always
 * flushes observability at the end so the heartbeat advances even when
 * both upstream calls fail — the UI can then distinguish "indexer dead"
 * from "miner REST temporarily down".
 */
export async function runTipIteration(deps: TipIterationDeps): Promise<void> {
  const { client, db, state } = deps;
  const nowMs = (deps.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();

  try {
    const status = await client.getStatus();
    if (status.ss58Address) {
      const prior = await db.getSelfAddress();
      if (prior !== status.ss58Address) {
        await db.setSelfAddress(status.ss58Address);
      }
      const hardware: MinerHardwareRecord = {
        accountId: status.ss58Address,
        nodeId: status.nodeId,
        miners: status.miners,
        primaryType: derivePrimaryType(status.miners),
        source: "self",
        observedAt: nowIso,
      };
      await db.upsertMinerHardware(hardware);
      state.observability.chainHeadFromNode = String(status.chainHeadNumber);
      // Pass-through the aggregator's per-backend breakdown so the
      // UI can render it without re-querying. Empty for single-process
      // miners; one entry per active mode for multi-process containers.
      state.observability.modes = status.modes;
    }
  } catch (e) {
    console.warn("[indexer/tip] /api/v1/status failed:", e instanceof Error ? e.message : e);
  }

  try {
    const stats: MinerStats = await client.getStats();
    state.observability.minerStats = stats;
  } catch (e) {
    console.warn("[indexer/tip] /api/v1/stats failed:", e instanceof Error ? e.message : e);
  }

  // Mining-attempts catch-up. Bound on the current global solution_number
  // (MR !105) = `count(WinningSolutions) + 1`, read straight from chain via
  // the substrate worker's `chain_head.winning_solutions_count`. The
  // miner's controller no longer exposes a per-solution counter, so the
  // bound is chain-derived, not from /api/v1/stats. Skip when selfAddress
  // is unknown or the substrate worker hasn't written the count yet (the
  // helper returns null), leaving the heartbeat write below intact. Errors
  // here never poison that heartbeat: catch broadly.
  const selfAddress = await db.getSelfAddress();
  if (selfAddress) {
    try {
      const currentSolutionNumber = await currentGlobalSolutionNumber(db);
      if (currentSolutionNumber !== null) {
        await catchUpMiningAttempts(deps, selfAddress, currentSolutionNumber, nowIso);
      }
    } catch (e) {
      console.warn(
        "[indexer/tip] mining-attempts catch-up failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  // Always flush observability — heartbeat must advance even on poll
  // failure so the UI can distinguish "indexer dead" from "miner REST
  // temporarily down".
  state.observability.lastStatusFetchAt = nowIso;
  await db.setIndexerObservability(state.observability);
}

/**
 * Heartbeat-only iteration. Used when the local operator hasn't been
 * discovered yet or the miner-REST URL can't be resolved. Bypasses every
 * REST call but still writes `lastStatusFetchAt` so the UI sees the
 * indexer process as live.
 */
async function flushHeartbeat(deps: TipWorkerDeps): Promise<void> {
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
  deps.state.observability.lastStatusFetchAt = nowIso;
  await deps.db.setIndexerObservability(deps.state.observability);
}

/**
 * Current global solution_number = `count(WinningSolutions) + 1` (MR !105),
 * read straight from chain via the substrate worker's
 * `chain_head.winning_solutions_count`. +1 is the in-flight problem every
 * miner is currently grinding.
 *
 * Returns null when chain_head hasn't been written yet, or when the chain
 * doesn't expose the count (pre-v0.2 runtime → `winningSolutionsCount` is
 * null) — the caller skips catch-up rather than bounding the walk on a
 * bogus value.
 */
async function currentGlobalSolutionNumber(db: DatabaseAdapter): Promise<number | null> {
  const head = await db.getChainHead();
  if (!head || head.winningSolutionsCount === null) return null;
  return head.winningSolutionsCount + 1;
}

/**
 * Persist completed global solution_numbers past the checkpoint, up to
 * {@link MINING_ATTEMPTS_PER_POLL_CAP} per tick. Completed (stable)
 * solution_numbers are `1 … currentSolutionNumber - 1`; the current one is
 * still in flight (the server surfaces it live, we never persist it).
 *
 * Unlike the pre-!105 per-result numbering, `solution_number` is the global
 * chain index and durable across restarts, so:
 *   - A 404 means this miner has no directory for that solution_number (it
 *     predates the miner, or — at the very head — the miner's own just-won
 *     directory hasn't flushed yet). We SKIP and advance rather than stop;
 *     a skipped self-win still shows in the UI as a chain-derived synthetic
 *     row, so the degradation is graceful.
 *   - There is no counter-regression "reset" to detect: the bound only
 *     advances, so we never wipe history on a restart.
 *
 * On first contact (or after long downtime) the checkpoint is seeded to
 * {@link MINING_ATTEMPTS_BACKFILL_WINDOW} below the head so we don't grind
 * thousands of ancient numbers this miner never had directories for.
 */
async function catchUpMiningAttempts(
  deps: TipIterationDeps,
  minerId: string,
  currentSolutionNumber: number,
  observedAt: string,
): Promise<void> {
  const { client, db } = deps;
  const highestCompleted = currentSolutionNumber - 1;
  if (highestCompleted < 1) return; // no winning solutions on-chain yet

  let checkpoint = (await db.getMiningCheckpoint(minerId)) ?? 0;
  const seedFloor = Math.max(0, highestCompleted - MINING_ATTEMPTS_BACKFILL_WINDOW);
  if (checkpoint < seedFloor) {
    // setMiningCheckpoint is monotonic-advance-only, so this only ever
    // skips ancient numbers forward — it can't rewind a healthy cursor.
    await db.setMiningCheckpoint(minerId, seedFloor);
    checkpoint = seedFloor;
  }
  if (checkpoint >= highestCompleted) return;

  const target = Math.min(highestCompleted, checkpoint + MINING_ATTEMPTS_PER_POLL_CAP);
  for (let n = checkpoint + 1; n <= target; n++) {
    try {
      const env = await client.getMiningAttempts(n);
      // The miner's API returns `miner_id` as the controller's internal
      // node id (e.g. "quip-miner-pow-CPU-1"). We persist under the chain
      // SS58 (`minerId`/`selfAddress`) so the table joins cleanly against
      // `chain_miners` and the server can look up by self. The original
      // miner_id is recoverable via the proxy on modal open.
      await db.insertMiningSubmission({
        ...env.submission,
        minerId,
        observedAt,
      });
    } catch (e) {
      if (!(e instanceof MiningSubmissionNotFoundError)) throw e;
      // Sparse gap — skip and advance the checkpoint below.
    }
    await db.setMiningCheckpoint(minerId, n);
  }
}

/**
 * Dominant miner type across `miners[]`. Ties broken by enum order
 * (CPU first, then GPU, QPU, OTHER) so a single-miner CPU node and a
 * single-miner GPU node both report something sensible.
 */
function derivePrimaryType(miners: Array<{ type: MinerCategory }>): MinerCategory {
  if (miners.length === 0) return "OTHER";
  const counts: Record<MinerCategory, number> = { CPU: 0, GPU: 0, QPU: 0, OTHER: 0 };
  for (const m of miners) counts[m.type]++;
  return (Object.entries(counts) as Array<[MinerCategory, number]>).sort(
    (a, b) => b[1] - a[1],
  )[0]![0];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
