// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "bun:test";
import { OWNED_TABLES, SCHEMA_VERSION } from "./adapter";
import type { DatabaseAdapter } from "./adapter";

test("schema v8: per-block difficulty sourced from quantumPowApi.winning_solution", () => {
  // v8 doesn't add tables — the bump triggers wipe-on-drift so existing
  // `blocks` rows (which carried approximate per-block difficulty from a
  // separate poll cadence) are refreshed with the per-block snapshot from
  // `WinningSolutions[block_number].difficulty`. OWNED_TABLES unchanged
  // from v7.
  expect(SCHEMA_VERSION).toBe(8);
  expect([...OWNED_TABLES]).toEqual([
    "blocks",
    "meta",
    "chain_head",
    "babe_epochs",
    "babe_authorities",
    "chain_miners",
    "difficulty_history",
    "miner_hardware",
    "validator_authorship",
  ]);
});

test("v8 DatabaseAdapter surface: validator_authorship methods (unchanged from v7)", () => {
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
    // hardware identity (v6)
    "upsertMinerHardware",
    "getMinerHardware",
    "getAllMinerHardware",
    // validator authorship (v7)
    "recordValidatorAuthorship",
    "getValidatorAuthorship",
  ];
  expect(required.length).toBe(26);
});
