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
    }
  } catch (e) {
    if (e instanceof AuthError) throw e;
    console.warn("[indexer/tip] /api/v1/status failed:", e instanceof Error ? e.message : e);
  }

  let proofsSubmitted: number | null = null;
  try {
    const stats: MinerStats = await client.getStats();
    state.observability.minerStats = stats;
    // `controller.proofs_submitted` is the monotonic counter that
    // `solution_id` draws from. Use it as the upper bound for the
    // attempts catch-up below — saves a probe-until-404 loop.
    proofsSubmitted = Number.isFinite(stats.proofsSubmitted) ? stats.proofsSubmitted : null;
  } catch (e) {
    if (e instanceof AuthError) throw e;
    console.warn("[indexer/tip] /api/v1/stats failed:", e instanceof Error ? e.message : e);
  }

  // Mining-attempts catch-up. Only run when both selfAddress and the
  // proofs_submitted counter are known — without either, we can't key
  // the checkpoint or bound the fetch range. Errors here never poison
  // the heartbeat write at the bottom of the function: catch broadly.
  const selfAddress = await db.getSelfAddress();
  if (selfAddress && proofsSubmitted !== null && proofsSubmitted > 0) {
    try {
      await catchUpMiningAttempts(deps, selfAddress, proofsSubmitted, nowIso);
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
  controllerProofsSubmitted: number,
  observedAt: string,
): Promise<void> {
  const { client, db } = deps;
  const checkpoint = (await db.getMiningCheckpoint(minerId)) ?? 0;
  if (controllerProofsSubmitted <= checkpoint) return;

  const target = Math.min(controllerProofsSubmitted, checkpoint + MINING_ATTEMPTS_PER_POLL_CAP);
  for (let id = checkpoint + 1; id <= target; id++) {
    try {
      const env = await client.getMiningAttempts(id);
      await db.insertMiningSubmission({
        ...env.submission,
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
