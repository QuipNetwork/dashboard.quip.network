// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "bun:test";
import { OWNED_TABLES, SCHEMA_VERSION } from "./adapter";
import type { DatabaseAdapter } from "./adapter";

test("schema v17: mining_submissions carries miner_type alongside num_valid", () => {
  // v17 adds miner_type (CPU / CUDA / METAL / MODAL / QPU) to each
  // mining_submissions row. Multi-backend containers run one
  // quip-miner process per active group; the dashboard needs to
  // report which backend produced each winning submission without
  // parsing miner_id. Empty string for rows from miners that don't
  // surface the field yet. Wipe-on-drift rebuilds existing rows
  // against the new shape on next indexer poll.
  expect(SCHEMA_VERSION).toBe(17);
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
