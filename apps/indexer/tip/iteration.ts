// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One tip-worker poll: fetch /api/v1/status → upsert self miner_hardware +
// selfAddress; fetch /api/v1/stats → cache minerStats; catch up persisted
// mining submissions bounded by the chain-derived global solution_number.
// The cadence/lifecycle that drives this lives in `./worker`.

import { concatMap, from, lastValueFrom, range } from "rxjs";

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import {
  MiningSubmissionNotFoundError,
  MiningSubmissionUnparsableError,
} from "@quip/core/miner-api";
import type { MinerCategory, MinerHardwareRecord, MinerStats } from "@quip/shared/telemetry";

import type { ChainStateReader } from "../core/chain-state";
import type { MinerSource } from "../clients/miner-client";
import { IndexerState } from "../core/state";

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
 * Per-iteration dependencies. The worker (in `./worker`) resolves the
 * miner-REST URL up-front and constructs the client; tests can call
 * `runTipIteration` directly with a fake client.
 */
export interface TipIterationDeps {
  client: MinerSource;
  db: DatabaseAdapter;
  state: IndexerState;
  chainState: ChainStateReader;
  now?: () => number;
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
      state.observability.selfIdentified = true;
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
  // = `LatestQBlockId + 1`, sourced from chain state via the injected
  // ChainStateReader. The miner's controller no longer exposes a
  // per-solution counter, so the bound is chain-derived, not from
  // /api/v1/stats. Skip when selfAddress is unknown or the reader returns
  // null (the substrate worker hasn't written the count yet), leaving the
  // heartbeat write below intact. Errors here never poison that heartbeat:
  // catch broadly.
  const selfAddress = await db.getSelfAddress();
  if (selfAddress) {
    try {
      const currentSolutionNumber = await deps.chainState.currentGlobalSolutionNumber();
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
  const { db } = deps;
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

  // Walk completed solution_numbers checkpoint+1 → target one at a time, the
  // same from(sequence) → concatMap shape the substrate backfill uses. A
  // non-404 error propagates and stops the walk with the checkpoint at the
  // last good number.
  const target = Math.min(highestCompleted, checkpoint + MINING_ATTEMPTS_PER_POLL_CAP);
  await lastValueFrom(
    range(checkpoint + 1, target - checkpoint).pipe(
      concatMap((n) => from(persistAttempt(deps, n, minerId, observedAt))),
    ),
    { defaultValue: undefined },
  );
}

/**
 * Persist one completed solution_number's submission, then advance the
 * checkpoint. A sparse 404 (this miner has no directory for that number) is
 * skipped — the checkpoint still advances so the walk doesn't stall on a gap.
 */
async function persistAttempt(
  deps: TipIterationDeps,
  n: number,
  minerId: string,
  observedAt: string,
): Promise<void> {
  const { client, db } = deps;
  try {
    const env = await client.getMiningAttempts(n);
    // The miner's API returns `miner_id` as the controller's internal node id
    // (e.g. "quip-miner-pow-CPU-1"). We persist under the chain SS58
    // (`minerId`/`selfAddress`) so the table joins cleanly against
    // `chain_miners` and the server can look up by self. The original miner_id
    // is recoverable via the proxy on modal open.
    await db.insertMiningSubmission({ ...env.submission, minerId, observedAt });
  } catch (e) {
    if (e instanceof MiningSubmissionUnparsableError) {
      // The miner answered, but the body cannot become a row (a missing field,
      // or a number outside the range the column accepts — see rule N1 in
      // the quip-miner v0.3 REST contract). Retrying produces the same
      // body, so treat it like a gap and advance. Warn loudly: this is data
      // loss for one solution_number, and the fix belongs in the miner.
      console.warn(`[indexer/tip] solution_number ${n} is unparsable, skipping:`, e.message);
    } else if (!(e instanceof MiningSubmissionNotFoundError)) {
      throw e;
    }
    // Sparse gap or poisoned body — skip and advance the checkpoint below.
  }
  await db.setMiningCheckpoint(minerId, n);
}

/**
 * Primary type for a rig, by hardware *capability* rather than process count:
 * a node with any GPU miner is a GPU node even when CPU worker processes
 * outnumber it (e.g. an Apple-silicon box running 6 CPU workers + 1 GPU/MPS
 * miner — the CPU workers are incidental filler). Priority GPU > QPU > CPU >
 * OTHER matches the dashboard's `derivePrimaryTypeFromDescriptor`, so the
 * self-status path and the chain-descriptor path classify the same rig
 * identically. Empty/OTHER-only miner lists fall through to OTHER.
 */
function derivePrimaryType(miners: Array<{ type: MinerCategory }>): MinerCategory {
  const present = new Set(miners.map((m) => m.type));
  for (const cat of ["GPU", "QPU", "CPU"] as const) {
    if (present.has(cat)) return cat;
  }
  return "OTHER";
}
