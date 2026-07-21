// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "bun:test";
import type { DatabaseAdapter } from "./adapter";

test("DatabaseAdapter v13 surface: mining submission + checkpoint methods", () => {
  type Methods = keyof DatabaseAdapter;
  const required: Methods[] = [
    "connect",
    "disconnect",
    "migrate",
    "migrationStatus",
    "pendingMigrations",
    // Blocks (substrate-canonical, no epoch coupling)
    "insertBlock",
    "getRecentBlocks",
    "getBlocksByMiner",
    "getBlocksMissingTopology",
    "setBlockTopology",
    "backfillDifficultyTopology",
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
    // mineable topologies (v0.2 protocol sync)
    "setMineableTopologies",
    "getMineableTopologies",
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
  expect(required.length).toBe(41);
});
