// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { sql, type Kysely } from "kysely";

import { getMigrations } from "../../migrations";
import { KyselyAdapter } from "./kysely-adapter";
import { migrateToLatest, migrationStatus, pendingMigrations } from "./migrator";
import { createPgliteKysely } from "./pglite-support";
import type { DB } from "./schema-types";

// Derived from the registry so adding a migration never breaks these tests —
// they assert the migrator drains whatever is registered, not a fixed list.
// Kysely runs migrations in sorted-name order.
const expectedNames = Object.keys(getMigrations()).sort();

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
    expect(await pendingMigrations(mk)).toEqual(expectedNames);

    const { applied } = await migrateToLatest(mk);
    expect(applied).toEqual(expectedNames);

    const status = await migrationStatus(mk);
    expect(status).toEqual(
      expectedNames.map((name) => ({ name, applied: true, executedAt: expect.any(Date) })),
    );
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
      qblockId: "1",
      nonce: "1",
      numNodes: 1,
      numEdges: 1,
      difficultyEnergy: -1,
      minDiversity: 0,
      minSolutions: 1,
      finalized: true,
      topologyHash: null,
    });
    await adapter.setSelfAddress("5SELF");
    await adapter.upsertChainHead({
      bestBlockNumber: "200",
      bestBlockHash: "0xb",
      finalizedBlockNumber: "190",
      finalizedBlockHash: "0xf",
      finalityLag: 10,
      winningSolutionsCount: 5,
      currentQBlockId: "6",
      currentQBlockParticipants: 3,
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
      topologyHash: null,
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
    expect(await pendingMigrations(mk)).toEqual(expectedNames);

    const { applied } = await migrateToLatest(mk);
    expect(applied).toEqual(expectedNames);

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

  it("reconciles a drifted node_descriptors (legacy payload_hash shape)", async () => {
    // Reproduce the real prod drift: a pre-monorepo DB whose node_descriptors
    // was created with the old column set (payload_hash, no block_hash /
    // extrinsic_index) under the SAME `0001_initial` name. The descriptor
    // worker's upsert writes block_hash + extrinsic_index, so the missing
    // columns make every scan fail. Migration 0004 must drop + recreate the
    // table to the canonical schema so writes succeed again.
    await migrateToLatest(mk);
    await sql`DROP TABLE node_descriptors`.execute(kysely);
    await sql`
      CREATE TABLE node_descriptors (
        account_id text PRIMARY KEY,
        block_number numeric NOT NULL,
        payload_hash text NOT NULL,
        block_timestamp bigint NOT NULL,
        first_block_timestamp bigint NOT NULL,
        descriptor jsonb NOT NULL,
        observed_at timestamptz NOT NULL
      )`.execute(kysely);
    // Un-record 0004 so the next migrateToLatest re-applies just it.
    await sql`DELETE FROM kysely_migration WHERE name = '0004_reconcile_descriptors_topology_tags'`.execute(
      kysely,
    );

    const { applied } = await migrateToLatest(mk);
    expect(applied).toEqual(["0004_reconcile_descriptors_topology_tags"]);

    // The canonical schema is back: a descriptor upsert (block_hash +
    // extrinsic_index) now succeeds where it previously threw.
    const adapter = new KyselyAdapter({ databaseUrl: "pglite" }, { db: kysely });
    await adapter.connect();
    await adapter.upsertNodeDescriptor({
      accountId: "5Node",
      blockNumber: "100",
      blockHash: "0xblk",
      extrinsicIndex: 0,
      blockTimestamp: 1700000000,
      firstBlockTimestamp: 1700000000,
      descriptor: {
        schema: "quip.node_descriptor.v1",
        descriptorVersion: 1,
        nodeName: "rig-1",
      },
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    const rows = await adapter.getAllNodeDescriptors();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.descriptor.nodeName).toBe("rig-1");
  });
});
