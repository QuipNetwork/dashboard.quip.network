// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseAdapter } from "../api/db/adapter";
import type { EpochId, NodesSnapshot } from "../src/types/telemetry";

import type { EpochsBody, QuipClient, StatusBody } from "./client";
import type { IndexerConfig } from "./config";
import type { IndexerState } from "./state";

/**
 * An epoch annotated with the block range it OWNS on its chain — the slice
 * of that chain's history first introduced during this epoch.
 *
 * Quip epochs carry the full chain history (from block 1) up to the epoch's
 * tip, so the same block_index can appear under multiple epoch URLs within
 * the same chain. Owned ranges disambiguate: each block is attributed to
 * exactly one epoch — the earliest epoch on its chain that contained it.
 *
 *   ownedStart = (previous epoch on THIS chain's lastBlock) + 1  (or 1 if
 *                this is the first epoch on the chain)
 *   ownedEnd   = this epoch's lastBlock (or status.latestBlockIndex for the
 *                tip epoch, which is fresher than /epochs)
 *
 * Dead chains (ones whose block-1 hash doesn't match `status.latestEpoch`'s)
 * still get indexed — operators want the forensic history of abandoned
 * branches. Grouping is by block-1 hash so each dead chain has its own
 * owned-range accounting.
 */
export interface CanonicalEpoch {
  epoch: EpochId;
  chainAnchor: string;
  ownedStart: number;
  ownedEnd: number;
}

export interface WorkerDeps {
  config: IndexerConfig;
  client: QuipClient;
  db: DatabaseAdapter;
  state: IndexerState;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Sleep for {@link ms} milliseconds, aborting early if {@link signal} fires.
 * Unlike plain `await sleep(ms)`, this resolves as soon as the abort event
 * dispatches — callers can check `signal.aborted` afterward to distinguish
 * normal completion from abort.
 */
export function sleepInterruptible(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function logPrefix(verb: "log" | "warn" | "error"): (...args: unknown[]) => void {
  const fn = console[verb].bind(console);
  return (...args: unknown[]) => fn("[indexer]", ...args);
}

const warn = logPrefix("warn");
const log = logPrefix("log");
const error = logPrefix("error");

export function formatErr(e: unknown): string {
  if (e instanceof Error) return e.stack ?? e.message;
  return String(e);
}

/**
 * Best-effort `state.save()` that swallows errors so the caller can continue
 * a cleanup/rethrow path without masking the original failure. Logs via the
 * shared `[indexer]` prefix so the save failure is visible in ops output.
 *
 * Used by both workers on the "about to rethrow a RateLimitError / other
 * error — try to flush the cursor first" path; keeping it here avoids two
 * near-identical copies drifting apart.
 */
export async function saveStateSafely(state: IndexerState, context: string): Promise<void> {
  try {
    await state.save();
  } catch (e) {
    error(`state.save failed after ${context}: ${formatErr(e)}`);
  }
}

/**
 * Update {@link IndexerState.stall} from a fresh status body. Called once
 * per successful /api/v1/telemetry/status fetch.
 *
 * Bootstrapping rule: on the very first observation we set
 * `lastAdvanceAtMs = nowMs` so `isNodeStalled` can't fire on the first
 * poll after startup (we have no prior observation to compare against).
 */
export function updateStallTracker(state: IndexerState, status: StatusBody, nowMs: number): void {
  const observed = { epoch: status.latestEpoch, blockIndex: status.latestBlockIndex };
  const prev = state.stall.lastObserved;
  if (prev === null) {
    state.stall.lastObserved = observed;
    state.stall.lastAdvanceAtMs = nowMs;
    return;
  }
  const advanced = observed.epoch !== prev.epoch || observed.blockIndex !== prev.blockIndex;
  if (advanced) {
    state.stall.lastObserved = observed;
    state.stall.lastAdvanceAtMs = nowMs;
    // Clear warn throttle so a re-stall immediately re-surfaces the WARN.
    state.stall.lastWarnAtMs = 0;
  }
}

/**
 * Emit the stall WARN at most once per {@link IndexerConfig.stallWarnAfterSec}
 * window. Uses {@link isNodeStalled} (D1 decision-point) to decide whether the
 * node is actually stalled.
 */
export function maybeWarnStalled(
  state: IndexerState,
  config: IndexerConfig,
  nowMs: number,
): boolean {
  if (config.stallWarnAfterSec <= 0) return false;
  const stallMs = nowMs - state.stall.lastAdvanceAtMs;
  const thresholdMs = config.stallWarnAfterSec * 1000;
  if (!isNodeStalled(stallMs, thresholdMs)) return false;
  // Re-emit at most once per threshold window while still stalled. Operators
  // want enough signal to notice, not a fire-hose.
  const sinceLastWarnMs = nowMs - state.stall.lastWarnAtMs;
  if (state.stall.lastWarnAtMs !== 0 && sinceLastWarnMs < thresholdMs) return false;
  const obs = state.stall.lastObserved;
  warn(
    `node appears stalled at ${config.nodeUrl}: latestEpoch=${obs?.epoch ?? "?"} ` +
      `latestBlockIndex=${obs?.blockIndex ?? "?"} unchanged for ` +
      `${Math.floor(stallMs / 1000)}s (threshold ${config.stallWarnAfterSec}s)`,
  );
  state.stall.lastWarnAtMs = nowMs;
  return true;
}

/**
 * D1 (learning-mode decision point): decide whether the polled node is stalled.
 *
 * Inputs:
 *  - stallMs: wall-clock ms since latestBlockIndex last advanced
 *  - thresholdMs: configured --stall-warn-after (converted to ms)
 *
 * Trade-offs to consider:
 *  - Pure time threshold is simplest; fires on legitimately slow periods
 *    (a QPU miner alone on the network can take tens of minutes per block).
 *  - A poll-count threshold would be scale-free but fragile to poll-interval
 *    tuning.
 *  - Grace on fresh boot: lastAdvanceAtMs is seeded on first poll so we never
 *    fire before we've observed one full window — that's already handled in
 *    updateStallTracker.
 *
 * Start simple: "stallMs >= thresholdMs". Iterate once there's real data.
 *
 * TODO (learning-mode): replace this one-liner with your preferred logic.
 */
export function isNodeStalled(stallMs: number, thresholdMs: number): boolean {
  return stallMs >= thresholdMs;
}

export async function refreshSelfAddress(
  db: DatabaseAdapter,
  client: QuipClient,
  snapshot: NodesSnapshot,
): Promise<void> {
  const matched = await resolveSelfAddress(client, snapshot);
  const current = await db.getSelfAddress();
  if (current !== matched) {
    await db.setSelfAddress(matched);
    if (matched) log(`self address resolved: ${matched}`);
  }
}

/**
 * Ask the node for its own peer-list address via GET /api/v1/status. The
 * node returns data.host — the exact key it uses for itself in the peer
 * list — so we can identify "us" with zero config regardless of how the
 * dashboard reaches it (docker DNS, caddy, direct IP, etc.). Returns null
 * if the node's identity isn't present in the current snapshot.
 */
export async function resolveSelfAddress(
  client: QuipClient,
  snapshot: NodesSnapshot,
): Promise<string | null> {
  const selfHost = await client.getSelfHost();
  if (!selfHost) return null;
  return snapshot.nodes[selfHost] ? selfHost : null;
}

/**
 * Fetch and cache an epoch's block-1 hash. The hash identifies the chain —
 * every epoch on the same chain shares the same block 1 because epochs
 * expose the cumulative chain history. Dead chains have distinct block-1
 * hashes from the canonical chain's block 1.
 *
 * Returns null if the node has no block 1 for this epoch yet (the epoch is
 * known but empty, e.g. just rolled over).
 */
export async function ensureChainAnchor(
  client: QuipClient,
  state: IndexerState,
  epoch: EpochId,
): Promise<string | null> {
  const cached = state.chainAnchors.get(epoch);
  if (cached !== undefined) return cached;
  const raw = await client.getBlock(epoch, 1);
  if (raw === null) return null;
  const hash = String(raw.block_hash ?? "");
  if (!hash) return null;
  state.chainAnchors.set(epoch, hash);
  return hash;
}

/**
 * Build the ordered list of epochs with owned block ranges across every
 * chain the node exposes (canonical + dead). Each epoch is tagged with its
 * chain anchor (block-1 hash) so the walker can detect chain transitions
 * and reset its block cursor.
 *
 * Ownership is computed per chain: within each chain group, sort by epoch
 * ID ascending and assign (previous epoch's lastBlock + 1) .. this epoch's
 * lastBlock. Forks on the same chain where a later epoch's lastBlock is
 * ≤ the previous one (a branch that never extended the tip) get an empty
 * range and don't index any blocks — their shared prefix is already
 * covered by an earlier epoch on the same chain.
 *
 * The tip epoch (latestEpoch per /status) uses status.latestBlockIndex
 * rather than /epochs.lastBlock — the status body is the freshest source
 * for the tip, /epochs can lag by one poll cycle.
 */
export async function buildCanonicalPlan(
  client: QuipClient,
  state: IndexerState,
  status: StatusBody,
  epochsBody: EpochsBody,
): Promise<CanonicalEpoch[]> {
  if (status.latestBlockIndex <= 0) return [];

  // Include the tip epoch even if /epochs hasn't caught up to it yet.
  const byEpoch = new Map<EpochId, { epoch: EpochId; lastBlock: number }>();
  for (const e of epochsBody.epochs) {
    byEpoch.set(e.epoch, { epoch: e.epoch, lastBlock: e.lastBlock });
  }
  byEpoch.set(status.latestEpoch, {
    epoch: status.latestEpoch,
    lastBlock: status.latestBlockIndex,
  });

  // Resolve each epoch's chain anchor (block-1 hash). Empty epochs (no
  // block 1) are dropped — they contribute nothing until blocks arrive.
  const byChain = new Map<string, Array<{ epoch: EpochId; lastBlock: number }>>();
  for (const e of byEpoch.values()) {
    if (e.lastBlock <= 0) continue;
    const anchor = await ensureChainAnchor(client, state, e.epoch);
    if (!anchor) continue;
    const group = byChain.get(anchor) ?? [];
    group.push(e);
    byChain.set(anchor, group);
  }

  // Compute per-chain owned ranges. Within each chain, sort by lastBlock
  // ascending — epoch IDs are hashes now, so lastBlock is the only
  // within-chain chronology signal we have. Across chains, sort by
  // (chainAnchor, ownedStart) so same-chain epochs walk contiguously and
  // the order is deterministic for a given node view.
  const plan: CanonicalEpoch[] = [];
  for (const [chainAnchor, epochs] of byChain) {
    epochs.sort((a, b) => a.lastBlock - b.lastBlock);
    let prevLast = 0;
    for (const e of epochs) {
      plan.push({
        epoch: e.epoch,
        chainAnchor,
        ownedStart: prevLast + 1,
        ownedEnd: e.lastBlock,
      });
      if (e.lastBlock > prevLast) prevLast = e.lastBlock;
    }
  }
  plan.sort((a, b) => {
    if (a.chainAnchor !== b.chainAnchor) return a.chainAnchor < b.chainAnchor ? -1 : 1;
    return a.ownedStart - b.ownedStart;
  });
  return plan;
}
