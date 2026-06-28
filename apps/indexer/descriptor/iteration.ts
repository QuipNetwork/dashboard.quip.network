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
 * One-shot iteration that snapshots the registry at a single block. Public for
 * tests so the per-snapshot contract can be exercised without a running loop.
 *
 * Returns true when the block was successfully processed (checkpoint
 * advanced); false when the block could not be fetched or decoded
 * (caller retries on the next tick without advancing).
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
