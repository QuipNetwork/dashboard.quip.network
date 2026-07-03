// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import type { ChainMinerRecord } from "@quip/shared/telemetry";
import { sortRows, useTableSort, type SortAccessors, type SortState } from "@/lib/table-sort";

export type MinerSortColumn =
  | "miner"
  | "version"
  | "deposit"
  | "proofsSubmitted"
  | "proofsWon"
  | "rewards"
  | "lastParticipation";

export type MinerSortState = SortState<MinerSortColumn>;

/**
 * Per-account lookups the table already computes for rendering (descriptor
 * join, last-won timestamps). Injected so the sorter stays pure and the
 * ordering always matches what the cells display.
 */
export interface MinerSortKeys {
  nameFor: (accountId: string) => string;
  versionFor: (accountId: string) => string | null;
  // Seconds since epoch of the account's most recent participation, or null
  // when it has never been seen participating.
  participationTsFor: (accountId: string) => number | null;
}

// u64/u128 chain counters arrive as decimal strings; BigInt keeps deposits
// and lifetime rewards ordered correctly past Number.MAX_SAFE_INTEGER.
function accessors(keys: MinerSortKeys): SortAccessors<ChainMinerRecord, MinerSortColumn> {
  return {
    miner: (m) => keys.nameFor(m.accountId),
    version: (m) => keys.versionFor(m.accountId),
    deposit: (m) => BigInt(m.deposit),
    proofsSubmitted: (m) => BigInt(m.proofsSubmitted),
    proofsWon: (m) => BigInt(m.proofsWon),
    rewards: (m) => BigInt(m.rewardsEarned),
    lastParticipation: (m) => keys.participationTsFor(m.accountId),
  };
}

export function sortChainMiners(
  rows: readonly ChainMinerRecord[],
  sort: MinerSortState,
  keys: MinerSortKeys,
): ChainMinerRecord[] {
  return sortRows(rows, sort, accessors(keys));
}

export function useChainMinerSort(rows: readonly ChainMinerRecord[], keys: MinerSortKeys) {
  const acc = useMemo(() => accessors(keys), [keys]);
  return useTableSort(rows, acc, { column: "lastParticipation", direction: "desc" });
}
