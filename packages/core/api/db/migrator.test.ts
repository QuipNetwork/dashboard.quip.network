// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { sql, type Kysely } from "kysely";

import { KyselyAdapter } from "./kysely-adapter";
import { migrateToLatest, migrationStatus, pendingMigrations } from "./migrator";
import { createPgliteKysely } from "./pglite-support";
import type { DB } from "./schema-types";

let kysely: Kysely<DB>;
let close: () => Promise<void>;
// The migrator functions take Kysely<unknown>; cast the typed pglite handle.
let mk: Kysely<unknown>;

beforeEach(async () => {
  ({ kysely, close } = await createPgliteKysely());
  mk = kysely as unknown as Kysely<unknown>;
});
afterEach(async () => {
  await close();
});

describe("migrator (postgres)", () => {
  it("applies the baseline to a fresh DB and records it in the ledger", async () => {
    expect(await pendingMigrations(mk)).toEqual(["0001_initial"]);

    const { applied } = await migrateToLatest(mk);
    expect(applied).toEqual(["0001_initial"]);

    const status = await migrationStatus(mk);
    expect(status).toEqual([{ name: "0001_initial", applied: true, executedAt: expect.any(Date) }]);
    expect(await pendingMigrations(mk)).toEqual([]);
  });

  it("is idempotent: a second run applies nothing", async () => {
    await migrateToLatest(mk);
    const { applied } = await migrateToLatest(mk);
    expect(applied).toEqual([]);
  });

  it("adopts a fully-populated pre-migration DB with no data loss", async () => {
    // Build the full schema, populate every table via the adapter, then drop
    // the ledger to emulate a DB that predates proper migrations (the realistic
    // prod state at cutover). Re-migrating must adopt it without wiping.
    await migrateToLatest(mk);
    const adapter = new KyselyAdapter({ databaseUrl: "pglite" }, { db: kysely });
    await adapter.connect();

    await adapter.insertBlock({
      blockHash: "0xkeep",
      substrateBlockNumber: "100",
      substrateBlockHash: "0xs",
      substrateParentHash: "0xp",
      timestamp: 1700000000,
      minerId: "5GPP",
      energy: -1,
      diversity: 0.1,
      numValidSolutions: 1,
      miningTime: 1,
      reward: "1000",
      nonce: "1",
      numNodes: 1,
      numEdges: 1,
      difficultyEnergy: -1,
      minDiversity: 0,
      minSolutions: 1,
      finalized: true,
    });
    await adapter.setSelfAddress("5SELF");
    await adapter.upsertChainHead({
      bestBlockNumber: "200",
      bestBlockHash: "0xb",
      finalizedBlockNumber: "190",
      finalizedBlockHash: "0xf",
      finalityLag: 10,
      winningSolutionsCount: 5,
      runtime: {
        specName: "quip",
        specVersion: 21,
        transactionVersion: 1,
        implName: "quip",
        lastRuntimeUpgrade: null,
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await adapter.upsertMinerHardware({
      accountId: "5GPP",
      nodeId: "n1",
      miners: [{ id: "m1", type: "GPU" }],
      primaryType: "GPU",
      source: "self",
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    await adapter.insertDifficultySnapshot({
      observedAtBlock: "150",
      difficultyEnergy: -1,
      minDiversity: 0,
      minSolutions: 1,
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    await adapter.recordValidatorAuthorship("5GPP", "199", 1700000000, true);
    await adapter.insertMiningSubmission({
      minerId: "5GPP",
      solutionNumber: 42,
      tsNs: "1700000000000000000",
      energyMilli: 1500,
      diversityMilli: 2500,
      thresholdMilli: 1000,
      lastProofBlockHash: "0xlp",
      extrinsicHash: null,
      chainBlockHash: null,
      chainBlockNumber: null,
      powSequence: 49,
      outcome: "submitted",
      attemptCount: 7,
      bestEnergyMilli: 1400,
      numValid: 3,
      minerType: "GPU",
      qpuAccessTimeUs: 0,
      observedAt: "2026-01-01T00:00:00.000Z",
    });

    // Drop the ledger → DB now looks "pre-migration" (schema + data, no ledger).
    await sql`DROP TABLE kysely_migration`.execute(kysely);
    expect(await pendingMigrations(mk)).toEqual(["0001_initial"]);

    const { applied } = await migrateToLatest(mk);
    expect(applied).toEqual(["0001_initial"]);

    // Every seeded row survived adoption.
    expect(await adapter.getRecentBlocks(10)).toHaveLength(1);
    expect(await adapter.getSelfAddress()).toBe("5SELF");
    expect(await adapter.getChainHead()).not.toBeNull();
    expect(await adapter.getAllMinerHardware()).toHaveLength(1);
    expect(await adapter.getRecentDifficulty(10)).toHaveLength(1);
    expect(await adapter.getValidatorAuthorship()).toHaveLength(1);
    expect(await adapter.getRecentMiningSubmissions("5GPP", 10)).toHaveLength(1);
    expect(await pendingMigrations(mk)).toEqual([]);
  });
});
