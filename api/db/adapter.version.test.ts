// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";
import { OWNED_TABLES, SCHEMA_VERSION } from "./adapter";

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
});
