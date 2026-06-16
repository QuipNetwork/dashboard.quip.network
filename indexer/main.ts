// SPDX-License-Identifier: AGPL-3.0-or-later

import { createAdapter } from "@quip/core/db";

import { DbChainStateReader } from "./chain-state";
import { QuipClient } from "./client";
import { parseConfig } from "./config";
import { runDescriptorLoop } from "./descriptor-worker";
import { IndexerState } from "./state";
import { PolkadotSubstrateClient, type SubstrateClient } from "./substrate-client";
import { runSubstrateLoop } from "./substrate-worker";
import { runTipLoop } from "./tip-worker";

export interface WorkerRunner {
  runTip: (signal: AbortSignal) => Promise<void>;
  runSubstrate: (signal: AbortSignal) => Promise<void>;
  // Node-descriptor indexer — scans finalized `MinerRegistry.NodeDescriptors`
  // snapshots written by operators running `quip-miner identify`.
  runDescriptor: (signal: AbortSignal) => Promise<void>;
}

type WorkerName = "tip" | "substrate" | "descriptor";

/**
 * Run the configured workers concurrently. Each worker receives a composed
 * {@link AbortSignal} that fires when either:
 *   - any worker throws a non-recoverable error — this aborts every
 *     sibling so the process exits cleanly rather than running half-up
 *   - the optional {@link parentSignal} (typically a process-level SIGINT
 *     controller) aborts
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
      if ((e as Error)?.name === "AbortError") return;
      console.error(
        `[indexer] ${name} unhandled error:`,
        e instanceof Error ? (e.stack ?? e.message) : e,
      );
      // Tip worker is the only fatal — substrate/descriptor failures
      // self-heal via their own reconnect loops, so we don't yank the
      // whole indexer for those.
      if (name === "tip") ac.abort();
      throw e;
    }
  };

  const results = await Promise.allSettled([
    wrap("tip", runners.runTip),
    wrap("substrate", runners.runSubstrate),
    wrap("descriptor", runners.runDescriptor),
  ]);
  const failed = results.some((r) => r.status === "rejected");
  return failed ? 1 : 0;
}

async function main(): Promise<number> {
  const config = parseConfig();
  console.log(
    `[indexer] starting validators=${config.validatorRpcUrls.join(",")} poll=${config.pollIntervalSec}s` +
      ` nodesRefresh=${config.nodesRefreshSec}s stallWarnAfter=${config.stallWarnAfterSec}s` +
      ` once=${config.once}`,
  );

  const db = await createAdapter();
  await db.connect();
  await db.migrate();

  // Seed selfAddress from --operator-account / QUIP_OPERATOR_ACCOUNT when
  // the DB has nothing cached. Skips the tip-worker's descriptor-probe
  // bootstrap and makes startup deterministic on split-host deployments
  // where the operator's descriptor hasn't landed yet. A cached value
  // already in the DB always wins — env config never clobbers history.
  if (config.operatorAccount) {
    const existing = await db.getSelfAddress();
    if (!existing) {
      await db.setSelfAddress(config.operatorAccount);
      console.log(
        `[indexer] selfAddress seeded from QUIP_OPERATOR_ACCOUNT=${config.operatorAccount}`,
      );
    }
  }

  const state = new IndexerState(db);
  await state.load();

  const processAc = new AbortController();
  const onSignal = (sig: string) => {
    console.log(`[indexer] received ${sig}, shutting down`);
    processAc.abort();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  // Substrate client factory: each connect attempt builds a fresh client
  // pointed at one of the configured RPC URLs (rotated by the worker's
  // outer reconnect loop). One shared client per worker (substrate +
  // descriptor) keeps the connect lifecycle independent — descriptor
  // failures don't drop substrate, and vice versa.
  const clientFactory = (url: string): SubstrateClient =>
    new PolkadotSubstrateClient(url, config.substrateRpcTimeoutMs);

  let exitCode = 0;
  try {
    exitCode = await runWorkers(
      {
        runTip: (signal) =>
          runTipLoop(
            {
              config,
              db,
              state,
              clientFactory: (baseUrl) => new QuipClient({ baseUrl }),
              chainState: new DbChainStateReader(db),
            },
            signal,
          ),
        runSubstrate: (signal) =>
          runSubstrateLoop(
            {
              config,
              db,
              state,
              urls: config.validatorRpcUrls,
              clientFactory,
            },
            signal,
          ),
        runDescriptor: (signal) =>
          runDescriptorLoop(
            {
              config,
              db,
              state,
              urls: config.validatorRpcUrls,
              clientFactory,
            },
            signal,
          ),
      },
      processAc.signal,
    );
  } catch (e) {
    exitCode = 1;
    console.error(`[indexer] workers failed:`, e instanceof Error ? (e.stack ?? e.message) : e);
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
