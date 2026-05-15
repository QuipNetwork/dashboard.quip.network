// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";
import { OWNED_TABLES, SCHEMA_VERSION } from "./adapter";
import type { DatabaseAdapter } from "./adapter";

describe("schema v5", () => {
  test("SCHEMA_VERSION is 5", () => {
    expect(SCHEMA_VERSION).toBe(5);
  });

  test("OWNED_TABLES includes new substrate tables", () => {
    expect([...OWNED_TABLES]).toEqual([
      "blocks",
      "nodes_snapshot",
      "epoch_status",
      "meta",
      "chain_head",
      "babe_epochs",
      "babe_authorities",
      "chain_miners",
      "difficulty_history",
    ]);
  });

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
