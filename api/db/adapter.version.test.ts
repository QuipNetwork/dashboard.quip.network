// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "bun:test";
import { OWNED_TABLES, SCHEMA_VERSION } from "./adapter";
import type { DatabaseAdapter } from "./adapter";

test("schema v21: mining_submissions re-keyed on global solution_number (MR !105)", () => {
  // v21 re-keys mining_submissions on the global chain `solution_number`
  // (count(WinningSolutions)+1, durable across restarts): the `solution_id`
  // column is renamed to `solution_number` and becomes the PK with
  // `miner_id`, and the now-gone controller-local `dispatch_id` column is
  // dropped. The indexer re-bounds its catch-up on the summed chain
  // `proofsWon` instead of the controller's `results_received` counter.
  // Wipe-on-drift rebuilds the table against the new key on the next poll.
  // (v20 added pow_sequence + re-sourced num_valid/Sol#; table shape is
  // otherwise unchanged apart from the column rename + dropped column.)
  expect(SCHEMA_VERSION).toBe(21);
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
