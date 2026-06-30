// SPDX-License-Identifier: AGPL-3.0-or-later

import { createAdapter } from "@quip/core/db";
import type { DatabaseAdapter } from "@quip/core/db/adapter";

import { DbChainStateReader } from "./core/chain-state";
import { QuipClient } from "./clients/miner-client";
import { parseConfig } from "./core/config";
import { DescriptorWorker } from "./descriptor";
import { IndexerState } from "./core/state";
import { PolkadotSubstrateClient, type SubstrateClient } from "./clients/substrate-client";
import { SubstrateWorker } from "./substrate";
import { backfillTopologyTags } from "./substrate/backfill-topology";
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

// Abortable sleep — resolves early when `signal` fires so a shutdown isn't held
// up by the retry delay.
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

// One-time topology-tag backfill, run in the background. Re-reads each legacy
// NULL block's qblock and stamps the topology it was won under, so the API's
// strict topology filter surfaces the current-topology history (rows predating
// migration 0004 carry NULL and would otherwise be hidden). Idempotent (only
// NULL rows remain to tag) and connection-resilient: it retries the connect
// because the validator endpoint may not be reachable at process start. Uses
// only runtime/storage reads (getQBlock, getMineableTopologies), so it works
// even when extrinsic decoding is broken on the block path.
const BACKFILL_CONNECT_TRIES = 12;
const BACKFILL_RETRY_MS = 5000;

async function runTopologyBackfill(
  client: SubstrateClient,
  db: DatabaseAdapter,
  signal: AbortSignal,
): Promise<void> {
  let connected = false;
  for (let attempt = 1; attempt <= BACKFILL_CONNECT_TRIES && !signal.aborted; attempt++) {
    try {
      await client.connect();
      connected = true;
      break;
    } catch {
      if (attempt < BACKFILL_CONNECT_TRIES) await sleep(BACKFILL_RETRY_MS, signal);
    }
  }
  if (!connected) {
    if (!signal.aborted) {
      console.warn("[indexer] topology backfill: could not connect; a restart will retry");
    }
    return;
  }
  try {
    if (signal.aborted) return;
    const s = await backfillTopologyTags({ source: client, store: db });
    if (s.tagged > 0 || s.capped) {
      console.log(
        `[indexer] topology backfill: tagged ${s.tagged} legacy blocks to the current topology ` +
          `(${s.difficultyTagged} difficulty rows)` +
          (s.reachedBoundary
            ? " — reached the last topology change"
            : s.capped
              ? " — capped; older current-topology blocks remain for the next run"
              : ""),
      );
    }
  } catch (e) {
    console.warn(`[indexer] topology backfill failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    await client.disconnect().catch(() => {});
  }
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

  // Kick off the one-time topology-tag backfill in the BACKGROUND so it never
  // delays worker startup, and let it retry the connect — at process start the
  // validator endpoint is often not reachable yet (the workers race to connect
  // too), and a single failed connect previously made the backfill skip itself,
  // leaving legacy blocks NULL and hidden by the strict topology filter.
  if (config.validatorRpcUrls.length > 0) {
    void runTopologyBackfill(clientFactory(config.validatorRpcUrls[0]!), db, processAc.signal);
  }

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
