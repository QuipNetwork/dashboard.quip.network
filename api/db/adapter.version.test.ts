// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "bun:test";
import { OWNED_TABLES, SCHEMA_VERSION } from "./adapter";
import type { DatabaseAdapter } from "./adapter";

test("schema v14: mining_submissions carries num_valid_solutions", () => {
  // v14 adds `num_valid_solutions` to mining_submissions, derived from
  // the submitted iteration's `num_valid` field. Surfaces in the Recent
  // Performance panel alongside diversity, replacing the
  // less-actionable threshold column.
  expect(SCHEMA_VERSION).toBe(14);
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
    "node_descriptors",
    "mining_submissions",
  ]);
});

test("DatabaseAdapter v13 surface: mining submission + checkpoint methods", () => {
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
    // Indexer observability (carries minerStats)
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
    // node descriptors (v11) — replaces v10's nodes_snapshot ingest path.
    "upsertNodeDescriptor",
    "getAllNodeDescriptors",
    "getDescriptorCheckpoint",
    "setDescriptorCheckpoint",
    // mining submissions (v13) — replaces v12 chain-side proof_attempts.
    "insertMiningSubmission",
    "getRecentMiningSubmissions",
    "getMiningCheckpoint",
    "setMiningCheckpoint",
  ];
  expect(required.length).toBe(34);
});
