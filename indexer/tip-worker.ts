// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseAdapter } from "../api/db/adapter";
import { MiningSubmissionNotFoundError } from "../api/miner-api";
import type { MinerCategory, MinerHardwareRecord, MinerStats } from "../src/types/telemetry";

import { AuthError, QuipClient } from "./client";
import type { IndexerConfig } from "./config";
import { IndexerState } from "./state";

// Cap on per-iteration submission fetches. A miner that's been running for
// hours before the indexer connects can have hundreds of submissions in its
// monotonic counter; fetching them all in one poll would block the loop
// and pressure the miner. 25 per tick keeps the catch-up bounded — at the
// default 5s poll cadence, an indexer can absorb 300 submissions/minute,
// well above realistic submit rates.
const MINING_ATTEMPTS_PER_POLL_CAP = 25;

export interface TipWorkerDeps {
  config: IndexerConfig;
  client: QuipClient;
  db: DatabaseAdapter;
  state: IndexerState;
  now?: () => number;
}

/**
 * Drive {@link runTipIteration} on a fixed cadence until the abort signal
 * fires. {@link AuthError} bubbles up to the caller (a bad token won't
 * self-heal); every other error is logged and the loop continues so a
 * single bad poll doesn't kill the worker.
 */
export async function runTipLoop(deps: TipWorkerDeps, signal: AbortSignal): Promise<void> {
  const intervalMs = deps.config.pollIntervalSec * 1000;
  while (!signal.aborted) {
    try {
      await runTipIteration(deps);
    } catch (e) {
      if (e instanceof AuthError) throw e;
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
 *
 * {@link AuthError} short-circuits both calls and rethrows so the loop
 * can exit. Other errors are logged and swallowed.
 */
export async function runTipIteration(deps: TipWorkerDeps): Promise<void> {
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
    if (e instanceof AuthError) throw e;
    console.warn("[indexer/tip] /api/v1/status failed:", e instanceof Error ? e.message : e);
  }

  let resultsReceived: number | null = null;
  try {
    const stats: MinerStats = await client.getStats();
    state.observability.minerStats = stats;
    // `controller.results_received` covers every dispatch that produced
    // a result — submitted_inblock AND chain_error. Using proofs_submitted
    // here would skip chain-rejected solutions, leaving them invisible
    // in the dashboard. solution_ids are monotonic and 1-indexed against
    // this counter on the miner side.
    resultsReceived = Number.isFinite(stats.resultsReceived) ? stats.resultsReceived : null;
  } catch (e) {
    if (e instanceof AuthError) throw e;
    console.warn("[indexer/tip] /api/v1/stats failed:", e instanceof Error ? e.message : e);
  }

  // Mining-attempts catch-up. Only run when both selfAddress and the
  // results_received counter are known — without either, we can't key
  // the checkpoint or bound the fetch range. We deliberately enter
  // even when resultsReceived is 0 so the reset-detection branch can
  // wipe stale rows when a fresh-restart miner reports an empty log.
  // Errors here never poison the heartbeat write at the bottom of the
  // function: catch broadly.
  const selfAddress = await db.getSelfAddress();
  if (selfAddress && resultsReceived !== null) {
    try {
      await catchUpMiningAttempts(deps, selfAddress, resultsReceived, nowIso);
    } catch (e) {
      if (e instanceof AuthError) throw e;
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
 * Fetch any solution_ids past the persisted checkpoint, up to
 * {@link MINING_ATTEMPTS_PER_POLL_CAP} per tick. Each successful fetch is
 * persisted via `db.insertMiningSubmission` and then the checkpoint
 * advances past it. A 404 stops the loop (we won't skip past missing
 * ids), and any other error rethrows so the caller can decide.
 *
 * `controllerProofsSubmitted` is the upper bound from `/api/v1/stats`;
 * if it's already at or behind the checkpoint, this is a no-op.
 */
async function catchUpMiningAttempts(
  deps: TipWorkerDeps,
  minerId: string,
  controllerResultsReceived: number,
  observedAt: string,
): Promise<void> {
  const { client, db } = deps;
  let checkpoint = (await db.getMiningCheckpoint(minerId)) ?? 0;
  // Miner reset detection: when the controller's results_received drops
  // below our checkpoint, the miner has wiped its attempts log (restart
  // without persistent state, or operator nuked /data). The persisted
  // submissions no longer correspond to anything on the live miner, so
  // their solution_ids are stale and modal lookups will 404. Drop them
  // and start over from 1.
  if (controllerResultsReceived < checkpoint) {
    console.warn(
      `[indexer/tip] miner reset detected for ${minerId}: ` +
        `results_received=${controllerResultsReceived} < checkpoint=${checkpoint}. ` +
        `Dropping persisted mining_submissions and refetching from 1.`,
    );
    await db.resetMiningHistory(minerId);
    checkpoint = 0;
  }
  if (controllerResultsReceived <= checkpoint) return;

  const target = Math.min(controllerResultsReceived, checkpoint + MINING_ATTEMPTS_PER_POLL_CAP);
  for (let id = checkpoint + 1; id <= target; id++) {
    try {
      const env = await client.getMiningAttempts(id);
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
      await db.setMiningCheckpoint(minerId, id);
    } catch (e) {
      if (e instanceof MiningSubmissionNotFoundError) {
        // The controller counter may be ahead of what the miner has
        // persisted to its attempts log (race between `proofs_submitted`
        // bump and the index write). Don't advance past the gap — next
        // poll retries this id.
        return;
      }
      throw e;
    }
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
