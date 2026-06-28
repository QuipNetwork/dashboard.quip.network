// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "bun:test";
import { OWNED_TABLES, SCHEMA_VERSION } from "./adapter";
import type { DatabaseAdapter } from "./adapter";

test("schema v23: qblock_id, current-qblock participation, mineable topologies", () => {
  // v22 re-sourced node_descriptors from MinerRegistry storage. v23 surfaces
  // three more v0.2 chain data points: blocks.qblock_id (per-block solution
  // number from the BlockWinner event), chain_head.current_qblock_id +
  // current_qblock_participants (the in-flight qblock and its MinerRegistry
  // participant count), and a mineable_topologies meta JSON row (per-topology
  // live difficulty + node/edge counts). Wipe-on-drift rebuilds blocks on the
  // next chain scan.
  expect(SCHEMA_VERSION).toBe(23);
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
    // per-topology difficulty snapshot (v23, meta-backed)
    "setMineableTopologies",
    "getMineableTopologies",
    // hardware identity (v6)
    "upsertMinerHardware",
    "getMinerHardware",
    "getAllMinerHardware",
    // validator authorship (v7)
    "recordValidatorAuthorship",
    "getValidatorAuthorship",
    // node descriptors — sourced from MinerRegistry.NodeDescriptors storage
    // (v0.2; replaced the v11 System.remark scan, which needed a checkpoint).
    "upsertNodeDescriptor",
    "getAllNodeDescriptors",
    // mining submissions (v13) — replaces v12 chain-side proof_attempts.
    "insertMiningSubmission",
    "getRecentMiningSubmissions",
    "getMiningCheckpoint",
    "setMiningCheckpoint",
  ];
  expect(required.length).toBe(34);
});
