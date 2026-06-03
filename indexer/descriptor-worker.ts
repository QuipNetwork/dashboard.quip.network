// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Descriptor worker (v0.2): the canonical chain-signed identity ingest
// path. Scans every finalized block for `System.remark{,_with_event}`
// extrinsics carrying a `quip.node_descriptor.v1` JSON body, validates
// each payload, and upserts a row into `node_descriptors` keyed by the
// extrinsic signer's SS58 account. Replaces the v0.2 miner-survey HTTP
// fan-out (deleted) with a single signed source of truth.
//
// See DASHBOARDPLAN.md for the indexing spec. This worker implements
// Path A (event-driven scan) with the simplification that we walk every
// block's extrinsics instead of first filtering on `System.Remarked`
// events — the block fetch dominates RPC cost either way, and most blocks
// carry zero remarks so the filter buys nothing.

import type { DatabaseAdapter } from "../api/db/adapter";

import type { IndexerConfig } from "./config";
import { parseAndValidateDescriptor } from "./descriptor-validator";
import type { IndexerState } from "./state";
import type { SubstrateClient } from "./substrate-client";

/**
 * Per-iteration dependencies for {@link runDescriptorIteration}. The loop
 * (below) constructs the client up front and reuses it across iterations;
 * tests can call `runDescriptorIteration` directly with a fake client.
 */
export interface DescriptorIterationDeps {
  client: SubstrateClient;
  db: DatabaseAdapter;
  now?: () => number;
}

/**
 * Long-running loop dependencies. The descriptor worker manages its own
 * substrate client lifecycle (independent of `runSubstrateLoop`) so a
 * descriptor-side connection failure doesn't drop the canonical block
 * writer. URL rotation is best-effort round-robin on connect failure.
 */
export interface DescriptorWorkerDeps {
  config: IndexerConfig;
  db: DatabaseAdapter;
  urls: string[];
  clientFactory: (url: string) => SubstrateClient;
  // Shared with substrate-worker — we read `observability.finalizedBlockHeight`
  // as the upper bound of work to do. Substrate-worker is the sole writer of
  // that field; we never mutate it.
  state: IndexerState;
  // Test hook for deterministic observedAt timestamps.
  now?: () => number;
}

// How long to wait when the worker is caught up to the finalized head, or
// when the substrate client is temporarily disconnected. Short enough to
// feel responsive on a healthy chain, long enough not to hot-spin.
const IDLE_POLL_MS = 2000;

// Backoff after a per-block RPC error. Substrate-worker handles connection
// recovery; we just slow down our scan so a transient RPC failure doesn't
// flood the logs.
const ERROR_BACKOFF_MS = 2000;

/**
 * Recognise the substrate RPC error a pruned-state validator returns when
 * asked about a historical block whose state has been discarded. Matches
 * polkadot.js error 4003 wording on substrate >=v0.9. We treat these as a
 * *permanent* miss: the block exists on chain but we can no longer decode
 * its body or timestamp, so the checkpoint must skip past it instead of
 * retrying forever (the hot-loop bug fixed in v0.2 smoke testing).
 */
function isPrunedStateError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /State already discarded|Unknown Block/i.test(msg);
}

/**
 * One-shot iteration that processes a single block. Public for tests so
 * the loop's per-block contract can be exercised without sleeping.
 *
 * Returns true when the block was successfully processed (checkpoint
 * advanced); false when the block could not be fetched or decoded
 * (caller retries on next tick without advancing).
 */
export async function runDescriptorIteration(
  deps: DescriptorIterationDeps,
  blockNumber: string,
): Promise<boolean> {
  const { client, db } = deps;
  const remarks = await client.getRemarksAtBlock(blockNumber);
  if (remarks === null) {
    // chain_getBlockHash returned the zero sentinel — the block doesn't
    // exist on the connected node yet. Treat as transient (the substrate
    // worker may need another tick to land it) and retry without
    // advancing the checkpoint.
    return false;
  }
  const observedAt = new Date((deps.now ?? Date.now)()).toISOString();
  for (const remark of remarks) {
    const result = parseAndValidateDescriptor(remark.body);
    if (!result.ok) {
      // Rejection is operator-actionable (bad JSON, schema mismatch,
      // credential leak, etc.) — log loudly so the operator can find
      // their bad descriptor.
      console.warn(
        `[indexer/descriptor] block ${remark.blockNumber} ext ${remark.extrinsicIndex} ` +
          `from ${remark.sender}: ${result.reason}`,
      );
      continue;
    }
    await db.upsertNodeDescriptor({
      accountId: remark.sender,
      blockNumber: remark.blockNumber,
      blockHash: remark.blockHash,
      extrinsicIndex: remark.extrinsicIndex,
      blockTimestamp: remark.blockTimestamp,
      // The adapter preserves the original first_block_timestamp across
      // upserts; passing the current block's timestamp here is correct
      // for first-ever inserts and harmlessly ignored on conflict.
      firstBlockTimestamp: remark.blockTimestamp,
      descriptor: result.descriptor,
      observedAt,
    });
  }
  await db.setDescriptorCheckpoint(blockNumber);
  return true;
}

/**
 * Main loop. Drains backfill (checkpoint+1 → finalized head) one block
 * at a time, then idles when caught up, polling substrate-worker's
 * shared `finalizedBlockHeight` for the next head. Aborts cleanly on
 * signal.
 *
 * Owns its own substrate client lifecycle — independent of the canonical
 * block writer — so a descriptor-side disconnect doesn't drop blocks and
 * vice versa. Rotates through `urls` round-robin on connect failure.
 */
export async function runDescriptorLoop(
  deps: DescriptorWorkerDeps,
  signal: AbortSignal,
): Promise<void> {
  const { config, db, state, urls, clientFactory } = deps;
  if (urls.length === 0) {
    throw new Error("[indexer/descriptor] urls list is empty; cannot connect");
  }

  // Resume from checkpoint if present, else from the configured start.
  // Checkpoint is the highest *successfully processed* block; we start at
  // checkpoint+1. Start block is a CHAIN block number, not an array index —
  // 1 is the first post-genesis block on substrate.
  const checkpoint = await db.getDescriptorCheckpoint();
  let nextBlock =
    checkpoint !== null ? BigInt(checkpoint) + 1n : BigInt(config.descriptorStartBlock);
  if (nextBlock < 1n) nextBlock = 1n;

  console.log(`[indexer/descriptor] starting scan from block ${nextBlock}`);

  let urlIdx = 0;
  while (!signal.aborted) {
    const url = urls[urlIdx]!;
    const client = clientFactory(url);
    try {
      await client.connect();
    } catch (e) {
      console.warn(
        `[indexer/descriptor] connect to ${url} failed: ${e instanceof Error ? e.message : e}`,
      );
      urlIdx = (urlIdx + 1) % urls.length;
      await sleep(ERROR_BACKOFF_MS, signal);
      continue;
    }

    const iterDeps: DescriptorIterationDeps = {
      client,
      db,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    };
    try {
      while (!signal.aborted && client.isConnected()) {
        const finalizedRaw = state.observability.finalizedBlockHeight;
        if (finalizedRaw === null) {
          await sleep(IDLE_POLL_MS, signal);
          continue;
        }
        const finalizedNum = parseBigIntOrNull(finalizedRaw);
        if (finalizedNum === null) {
          await sleep(IDLE_POLL_MS, signal);
          continue;
        }
        if (nextBlock > finalizedNum) {
          await sleep(IDLE_POLL_MS, signal);
          continue;
        }

        try {
          const advanced = await runDescriptorIteration(iterDeps, nextBlock.toString());
          if (advanced) {
            nextBlock += 1n;
          } else {
            await sleep(ERROR_BACKOFF_MS, signal);
          }
        } catch (e) {
          if (isPrunedStateError(e)) {
            console.warn(`[indexer/descriptor] block ${nextBlock} state pruned; skipping`);
            await db.setDescriptorCheckpoint(nextBlock.toString());
            nextBlock += 1n;
          } else {
            console.warn(
              `[indexer/descriptor] block ${nextBlock} scan failed:`,
              e instanceof Error ? e.message : e,
            );
            await sleep(ERROR_BACKOFF_MS, signal);
          }
        }
      }
    } finally {
      try {
        await client.disconnect();
      } catch {
        // best-effort
      }
    }

    if (signal.aborted) return;
    // Connection dropped — rotate URL and reconnect.
    urlIdx = (urlIdx + 1) % urls.length;
    await sleep(ERROR_BACKOFF_MS, signal);
  }
}

function parseBigIntOrNull(s: string): bigint | null {
  try {
    return BigInt(s);
  } catch {
    return null;
  }
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
