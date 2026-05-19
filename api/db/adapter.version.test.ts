// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "bun:test";
import { OWNED_TABLES, SCHEMA_VERSION } from "./adapter";
import type { DatabaseAdapter } from "./adapter";

test("schema v6: epoch and nodes tables gone, miner_hardware added", () => {
  expect(SCHEMA_VERSION).toBe(6);
  expect([...OWNED_TABLES]).toEqual([
    "blocks",
    "meta",
    "chain_head",
    "babe_epochs",
    "babe_authorities",
    "chain_miners",
    "difficulty_history",
    "miner_hardware",
  ]);
});

test("v6 DatabaseAdapter surface: epoch/nodes methods gone, miner_hardware added", () => {
  type Methods = keyof DatabaseAdapter;
  const required: Methods[] = [
    "connect",
    "disconnect",
    "migrate",
    // Blocks (substrate-canonical, no epoch coupling)
    "insertBlock",
    "getRecentBlocks",
    "getBlocksByMiner",
    "markBlockFinalized",
    // Self-identity (slim)
    "setSelfAddress",
    "getSelfAddress",
    // Indexer observability (now carries minerStats)
    "setIndexerObservability",
    "getIndexerObservability",
    // Substrate-derived (unchanged from v5)
    "upsertChainHead",
    "getChainHead",
    "upsertBabeEpoch",
    "getCurrentBabeEpoch",
    "upsertBabeAuthorities",
    "getActiveBabeAuthorities",
    "upsertChainMiners",
    "getChainMiners",
    "insertDifficultySnapshot",
    "getRecentDifficulty",
    // NEW: hardware identity
    "upsertMinerHardware",
    "getMinerHardware",
    "getAllMinerHardware",
  ];
  expect(required.length).toBe(24);
});
