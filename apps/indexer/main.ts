// SPDX-License-Identifier: AGPL-3.0-or-later

import { createAdapter } from "@quip/core/db";

import { DbChainStateReader } from "./core/chain-state";
import { QuipClient } from "./clients/miner-client";
import { parseConfig } from "./core/config";
import { DescriptorWorker } from "./descriptor";
import { IndexerState } from "./core/state";
import { PolkadotSubstrateClient, type SubstrateClient } from "./clients/substrate-client";
import { SubstrateWorker } from "./substrate";
import { TipWorker } from "./tip";
import type { Worker } from "./core/worker";

export interface WorkerSpec {
  name: string;
  worker: Worker;
  // A fatal worker's failure aborts its siblings and fails the whole run; a
  // non-fatal worker's failure is logged and the others keep going (it
  // self-heals via its own reconnect loop). Only the tip worker is fatal.
  fatal: boolean;
}

/**
 * Run the workers concurrently. Each receives a composed {@link AbortSignal}
 * that fires when either:
 *   - a {@link WorkerSpec.fatal} worker throws — this aborts every sibling so
 *     the process exits cleanly rather than running half-up
 *   - the optional {@link parentSignal} (typically a process-level SIGINT
 *     controller) aborts
 *
 * Returns 0 when all workers complete normally, 1 when any rejects.
 */
export async function runWorkers(specs: WorkerSpec[], parentSignal?: AbortSignal): Promise<number> {
  const ac = new AbortController();
  const signals = parentSignal ? [ac.signal, parentSignal] : [ac.signal];
  const combined = signals.length === 1 ? ac.signal : AbortSignal.any(signals);

  const wrap = async (spec: WorkerSpec): Promise<void> => {
    try {
      await spec.worker.run(combined);
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      console.error(
        `[indexer] ${spec.name} unhandled error:`,
        e instanceof Error ? (e.stack ?? e.message) : e,
      );
      if (spec.fatal) ac.abort();
      throw e;
    }
  };

  const results = await Promise.allSettled(specs.map(wrap));
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

  // Tip is the only fatal worker — substrate/descriptor self-heal via their
  // own reconnect loops, so their failures don't yank the whole indexer.
  const specs: WorkerSpec[] = [
    {
      name: "tip",
      fatal: true,
      worker: new TipWorker({
        config,
        db,
        state,
        clientFactory: (baseUrl) => new QuipClient({ baseUrl }),
        chainState: new DbChainStateReader(db),
      }),
    },
    {
      name: "substrate",
      fatal: false,
      worker: new SubstrateWorker({
        config,
        db,
        state,
        urls: config.validatorRpcUrls,
        clientFactory,
      }),
    },
    {
      name: "descriptor",
      fatal: false,
      worker: new DescriptorWorker({
        config,
        db,
        state,
        urls: config.validatorRpcUrls,
        clientFactory,
      }),
    },
  ];

  let exitCode = 0;
  try {
    exitCode = await runWorkers(specs, processAc.signal);
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
