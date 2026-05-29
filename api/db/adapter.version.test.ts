// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "bun:test";
import { OWNED_TABLES, SCHEMA_VERSION } from "./adapter";
import type { DatabaseAdapter } from "./adapter";

test("schema v19: mining_submissions.num_valid re-sourced from solution_meta.n_unique_total", () => {
  // v19 re-points the Recent Performance "Solutions" column
  // (mining_submissions.num_valid) at the submitted iteration's
  // `solution_meta.n_unique_total` (quip-protocol MR !103), falling
  // back to the legacy top-level `num_valid` for pre-!103 miners.
  // !103 dropped the per-iter `num_solutions_meeting_target` field and
  // re-pointed `num_valid` to the target-aware below-threshold count,
  // so an old indexer would have stored the trivial "~min_solutions"
  // figure in the productivity column. Wipe-on-drift rebuilds the
  // column from n_unique_total on next indexer poll. (v18 added the
  // qpu_access_time_us column; the table shape is otherwise unchanged.)
  expect(SCHEMA_VERSION).toBe(19);
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
