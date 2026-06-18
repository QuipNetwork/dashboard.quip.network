// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Offline reconstruction of true `first_block_timestamp` ("firstSeen") for node
// descriptors. The live head-snapshot path only ever observes each account's
// latest `updated_at`, so a from-scratch rebuild seeds firstSeen from the most
// recent registration rather than the first. This recovers the truth without
// the old O(blocks × nodes) per-block walk: for each account it binary-searches
// the earliest finalized block at which its descriptor was present, then records
// that block's timestamp. Cost is O(accounts × log(head)) single-key reads, and
// it requires an archive node (historical state must be retained).
//
// Assumes presence is monotonic — once an account registers it stays in the
// registry. A deregister-then-reregister would make the search settle on a
// later boundary; node identity is register/update in practice, so this is an
// accepted simplification. The DB write only ever lowers firstSeen, so a stray
// later boundary can never corrupt an already-correct value.

import type { NodeDescriptorRecord } from "@quip/shared/telemetry";

// Narrow chain slice (ISP) — satisfied structurally by SubstrateClient.
export interface FirstSeenSource {
  // Current finalized head as a decimal block-number string.
  getFinalizedHead(): Promise<string>;
  // Whether `accountId`'s descriptor exists in MinerRegistry storage at `blockNumber`.
  isDescriptorPresentAt(accountId: string, blockNumber: string): Promise<boolean>;
  // Unix-seconds timestamp of `blockNumber`.
  getBlockTimestamp(blockNumber: string): Promise<number>;
}

// Narrow DB slice (ISP) — satisfied structurally by DatabaseAdapter.
export interface FirstSeenStore {
  getAllNodeDescriptors(): Promise<NodeDescriptorRecord[]>;
  backfillNodeDescriptorFirstSeen(accountId: string, firstBlockTimestamp: number): Promise<void>;
}

export interface ReconstructDeps {
  source: FirstSeenSource;
  store: FirstSeenStore;
  log?: (msg: string) => void;
}

export interface ReconstructSummary {
  accountsProcessed: number; // descriptors present at head and corrected
  accountsSkipped: number; // rows not present at head (stale / deregistered)
  presenceReads: number; // isDescriptorPresentAt calls (the dominant cost)
}

export async function reconstructFirstSeen(deps: ReconstructDeps): Promise<ReconstructSummary> {
  const { source, store } = deps;
  const log = deps.log ?? (() => {});

  const head = await source.getFinalizedHead();
  const headNum = BigInt(head);
  const rows = await store.getAllNodeDescriptors();

  let accountsProcessed = 0;
  let accountsSkipped = 0;
  let presenceReads = 0;
  const presentAt = (accountId: string, block: bigint): Promise<boolean> => {
    presenceReads += 1;
    return source.isDescriptorPresentAt(accountId, block.toString());
  };

  for (const { accountId } of rows) {
    if (headNum < 1n || !(await presentAt(accountId, headNum))) {
      accountsSkipped += 1;
      continue;
    }
    // Binary-search the earliest present block in [1, head]: the descriptor is
    // present at `hi` and we narrow until lo === hi at the first-appearance.
    let lo = 1n;
    let hi = headNum;
    while (lo < hi) {
      const mid = lo + (hi - lo) / 2n;
      if (await presentAt(accountId, mid)) hi = mid;
      else lo = mid + 1n;
    }
    const firstSeen = await source.getBlockTimestamp(lo.toString());
    await store.backfillNodeDescriptorFirstSeen(accountId, firstSeen);
    accountsProcessed += 1;
  }

  log(
    `[indexer/descriptor] firstSeen reconstruction: ${accountsProcessed} corrected, ` +
      `${accountsSkipped} skipped, ${presenceReads} presence reads (head=${head})`,
  );
  return { accountsProcessed, accountsSkipped, presenceReads };
}
