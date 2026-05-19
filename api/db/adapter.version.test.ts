// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";
import { OWNED_TABLES, SCHEMA_VERSION } from "./adapter";
import type { DatabaseAdapter } from "./adapter";

describe("schema v5", () => {
  test("DatabaseAdapter exposes substrate methods", () => {
    // Compile-time check: each name must be a key of DatabaseAdapter.
    // Stripping typecheck would catch a missing method via tsc, not at
    // runtime — this is a documentation/sanity assertion.
    type Methods = keyof DatabaseAdapter;
    const required: Methods[] = [
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
      "updateBlockSubstrateFields",
      "findBlockByMinerAndEnergy",
      "markBlocksCanonical",
      "updateEpochChainAnchor",
    ];
    expect(required.length).toBe(14);
  });
});

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
