// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Descriptor worker (v0.2): the canonical chain-signed identity ingest path.
// One iteration snapshots finalized `MinerRegistry.NodeDescriptors` state at a
// single block and upserts one row per chain account. The block-by-block
// cursor drain that drives this lives in `./worker`.

import type { DatabaseAdapter } from "@quip/core/db/adapter";

import type { MinerRegistryDescriptorRecord } from "../clients/substrate-client";

// Role-narrowed read slice of the substrate client (ISP) — the only chain call
// an iteration makes.
export interface DescriptorReadSource {
  getMinerRegistryDescriptorsAt(
    blockNumber: string,
  ): Promise<MinerRegistryDescriptorRecord[] | null>;
}

/**
 * Per-iteration dependencies. The worker (in `./worker`) owns the client
 * lifecycle; tests can call `runDescriptorIteration` directly with a fake.
 */
export interface DescriptorIterationDeps {
  client: DescriptorReadSource;
  db: DatabaseAdapter;
  now?: () => number;
}

/**
 * Recognise the substrate RPC error a pruned-state validator returns when
 * asked about a historical block whose state has been discarded. Matches
 * polkadot.js error 4003 wording on substrate >=v0.9. We treat these as a
 * *permanent* miss: the block exists on chain but we can no longer decode
 * its body or timestamp, so the checkpoint must skip past it instead of
 * retrying forever (the hot-loop bug fixed in v0.2 smoke testing).
 */
export function isPrunedStateError(e: unknown): boolean {
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
  const descriptors = await client.getMinerRegistryDescriptorsAt(blockNumber);
  if (descriptors === null) {
    // chain_getBlockHash returned the zero sentinel — the block doesn't
    // exist on the connected node yet. Treat as transient (the substrate
    // worker may need another tick to land it) and retry without
    // advancing the checkpoint.
    return false;
  }
  const observedAt = new Date((deps.now ?? Date.now)()).toISOString();
  for (const row of descriptors) {
    await db.upsertNodeDescriptor({
      accountId: row.accountId,
      blockNumber: row.blockNumber,
      blockHash: row.blockHash,
      // Registry storage snapshots have account/block provenance, not an
      // extrinsic position. One descriptor per account can exist at any
      // finalized state, so 0 is stable for the existing DB tie-breaker.
      extrinsicIndex: 0,
      blockTimestamp: row.blockTimestamp,
      // The adapter preserves the original first_block_timestamp across
      // upserts; passing the current block's timestamp here is correct
      // for first-ever inserts and harmlessly ignored on conflict.
      firstBlockTimestamp: row.blockTimestamp,
      descriptor: row.descriptor,
      observedAt,
    });
  }
  await db.setDescriptorCheckpoint(blockNumber);
  return true;
}
