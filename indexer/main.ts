// SPDX-License-Identifier: AGPL-3.0-or-later

import { createAdapter } from "../api/db";

import { runBackfillLoop } from "./backfill-worker";
import { AuthError, QuipClient } from "./client";
import { parseConfig } from "./config";
import { IndexerState } from "./state";
import { PolkadotSubstrateClient } from "./substrate-client";
import { runSubstrateLoop } from "./substrate-worker";
import { runTipLoop } from "./tip-worker";

export interface WorkerRunner {
  runTip: (signal: AbortSignal) => Promise<void>;
  runBackfill: (signal: AbortSignal) => Promise<void>;
  // Optional. Configured only when QUIP_VALIDATOR_RPC_URL is set; absence
  // means the indexer runs in REST-only degraded mode (dashboard chain
  // surfaces stay null/empty).
  runSubstrate?: (signal: AbortSignal) => Promise<void>;
}

type WorkerName = "tip" | "backfill" | "substrate";

/**
 * Run the configured workers concurrently. Each worker receives a composed
 * {@link AbortSignal} that fires when either:
 *   - a fatal worker (tip/backfill) throws an {@link AuthError} or other
 *     fatal — this aborts every sibling
 *   - the optional {@link parentSignal} (typically a process-level SIGINT
 *     controller) aborts
 *
 * Substrate failures are NON-fatal: they're logged and the indexer keeps
 * running REST polling. The chain surfaces just stop updating until the
 * substrate worker reconnects on its own internal backoff loop.
 *
 * Returns 0 when all workers complete normally, 1 when any rejects.
 */
export async function runWorkers(
  runners: WorkerRunner,
  parentSignal?: AbortSignal,
): Promise<number> {
  const ac = new AbortController();
  const signals = parentSignal ? [ac.signal, parentSignal] : [ac.signal];
  const combined = signals.length === 1 ? ac.signal : AbortSignal.any(signals);

  const wrap = async (name: WorkerName, fn: (s: AbortSignal) => Promise<void>): Promise<void> => {
    try {
      await fn(combined);
    } catch (e) {
      if (e instanceof AuthError) {
        console.error(`[indexer] ${name} auth failed:`, e.message);
        // Substrate auth errors don't take down REST workers. The substrate
        // worker's own backoff loop already handles retries; an auth error
        // means the RPC token is bad, which is operator-actionable but
        // shouldn't stop block indexing.
        if (name !== "substrate") ac.abort();
        throw e;
      }
      if ((e as Error)?.name === "AbortError") return;
      console.error(
        `[indexer] ${name} unhandled error:`,
        e instanceof Error ? (e.stack ?? e.message) : e,
      );
      if (name !== "substrate") ac.abort();
      throw e;
    }
  };

  const promises: Promise<void>[] = [
    wrap("tip", runners.runTip),
    wrap("backfill", runners.runBackfill),
  ];
  if (runners.runSubstrate) {
    promises.push(wrap("substrate", runners.runSubstrate));
  }

  const results = await Promise.allSettled(promises);
  const failed = results.some((r) => r.status === "rejected");
  return failed ? 1 : 0;
}

async function main(): Promise<number> {
  const config = parseConfig();
  console.log(
    `[indexer] starting node=${config.nodeUrl} poll=${config.pollIntervalSec}s` +
      ` nodesRefresh=${config.nodesRefreshSec}s stallWarnAfter=${config.stallWarnAfterSec}s` +
      ` backfillIdleRecheck=${config.backfillIdleRecheckSec}s once=${config.once}` +
      ` substrate=${config.substrateRpcUrl ?? "disabled"}`,
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

  // Substrate worker is opt-in via QUIP_VALIDATOR_RPC_URL. Configured here
  // so the runner stays a no-op when unset (runWorkers also skips it).
  const substrateClient = config.substrateRpcUrl
    ? new PolkadotSubstrateClient(config.substrateRpcUrl, config.substrateRpcTimeoutMs)
    : null;
  const runSubstrate = substrateClient
    ? (signal: AbortSignal) =>
        runSubstrateLoop({ config, client: substrateClient, db, state }, signal)
    : undefined;

  let exitCode = 0;
  try {
    exitCode = await runWorkers(
      {
        runTip: (signal) => runTipLoop({ config, client: tipClient, db, state }, signal),
        runBackfill: (signal) =>
          runBackfillLoop({ config, client: backfillClient, db, state }, signal),
        ...(runSubstrate ? { runSubstrate } : {}),
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
