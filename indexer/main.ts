// SPDX-License-Identifier: AGPL-3.0-or-later

import { createAdapter } from "../api/db";

import { runBackfillLoop } from "./backfill-worker";
import { AuthError, QuipClient } from "./client";
import { parseConfig } from "./config";
import { IndexerState } from "./state";
import { runTipLoop } from "./tip-worker";

export interface WorkerRunner {
  runTip: (signal: AbortSignal) => Promise<void>;
  runBackfill: (signal: AbortSignal) => Promise<void>;
}

/**
 * Run the tip and backfill workers concurrently. Each worker receives a
 * composed {@link AbortSignal} that fires when either:
 *   - the sibling worker throws an {@link AuthError} or other fatal
 *   - the optional {@link parentSignal} (typically a process-level SIGINT
 *     controller) aborts
 *
 * AuthError rethrown from either worker triggers `ac.abort()` so the sibling
 * sees the combined signal fire and exits cleanly. Any non-Abort exception
 * from a worker is also treated as fatal — workers are expected to swallow
 * transient errors internally, so a leaked error means the worker's own
 * error-handling failed.
 *
 * Returns 0 when both workers complete normally, 1 when either rejects.
 */
export async function runWorkers(
  runners: WorkerRunner,
  parentSignal?: AbortSignal,
): Promise<number> {
  const ac = new AbortController();
  const signals = parentSignal ? [ac.signal, parentSignal] : [ac.signal];
  const combined = signals.length === 1 ? ac.signal : AbortSignal.any(signals);

  const wrap = async (
    name: "tip" | "backfill",
    fn: (s: AbortSignal) => Promise<void>,
  ): Promise<void> => {
    try {
      await fn(combined);
    } catch (e) {
      if (e instanceof AuthError) {
        console.error(`[indexer] ${name} auth failed:`, e.message);
        ac.abort();
        throw e;
      }
      if ((e as Error)?.name === "AbortError") return;
      console.error(
        `[indexer] ${name} unhandled error:`,
        e instanceof Error ? (e.stack ?? e.message) : e,
      );
      ac.abort();
      throw e;
    }
  };

  const results = await Promise.allSettled([
    wrap("tip", runners.runTip),
    wrap("backfill", runners.runBackfill),
  ]);
  const failed = results.some((r) => r.status === "rejected");
  return failed ? 1 : 0;
}

async function main(): Promise<number> {
  const config = parseConfig();
  console.log(
    `[indexer] starting node=${config.nodeUrl} poll=${config.pollIntervalSec}s` +
      ` nodesRefresh=${config.nodesRefreshSec}s stallWarnAfter=${config.stallWarnAfterSec}s` +
      ` backfillIdleRecheck=${config.backfillIdleRecheckSec}s once=${config.once}` +
      (config.backfillFromEpoch !== undefined ? ` backfillFrom=${config.backfillFromEpoch}` : ""),
  );

  const db = await createAdapter();
  await db.connect();
  await db.migrate();

  // Separate QuipClient instances so the two workers can't deadlock each
  // other on a shared in-flight request (not strictly required today — the
  // client is stateless across calls — but cheap insurance).
  const tipClient = new QuipClient({ baseUrl: config.nodeUrl, token: config.token });
  const backfillClient = new QuipClient({ baseUrl: config.nodeUrl, token: config.token });
  const state = new IndexerState(db);
  await state.load();

  const processAc = new AbortController();
  const onSignal = (sig: string) => {
    console.log(`[indexer] received ${sig}, shutting down`);
    processAc.abort();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  let exitCode = 0;
  try {
    exitCode = await runWorkers(
      {
        runTip: (signal) =>
          runTipLoop({ config, client: tipClient, db, state }, signal),
        runBackfill: (signal) =>
          runBackfillLoop({ config, client: backfillClient, db, state }, signal),
      },
      processAc.signal,
    );
    await state.save();
  } catch (e) {
    exitCode = 1;
    const label = e instanceof AuthError ? "auth failed" : "workers failed";
    console.error(`[indexer] ${label}:`, e instanceof Error ? (e.stack ?? e.message) : e);
  } finally {
    await db.disconnect();
  }
  console.log("[indexer] stopped");
  return exitCode;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error("[indexer] fatal:", e instanceof Error ? (e.stack ?? e.message) : e);
      process.exit(1);
    },
  );
}
