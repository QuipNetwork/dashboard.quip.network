// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `winners` plugin (spec §4 registry): the canonical qblock writer. Body is a
// move of the old enrich path (`substrate/blocks.ts` enrichBlock +
// buildBlockRecord), with the order-dependent difficulty `scan` replaced by
// the block's own qblock difficulty — pre-v0.2 winners (no qblock) write the
// decided ZERO_DIFFICULTY triple instead of an order-dependent guess
// (spec §10.2).

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import type { BlockRecord } from "@quip/shared/telemetry";

import type { DifficultyInfo } from "../../clients/substrate-client";
import { BABE_SLOT_DURATION_SEC } from "../../substrate/shared";
import type { ChainClient } from "../../substrate/ports";
import type { BlockContext, BlockIndexable } from "../plugin";

const ZERO_DIFFICULTY: DifficultyInfo = {
  maxEnergyMilli: 0,
  minDiversityMilli: 0,
  minSolutions: 0,
};

/** Earliest block the winner walk can reach: the qBlocks map floor. */
export async function winnerStartBlock(client: ChainClient): Promise<number> {
  const nums = await client.getQBlockNumbers();
  if (nums.length === 0) return 0;
  return nums.reduce((min, s) => Math.min(min, Number(s)), Infinity);
}

export function winnersPlugin(): BlockIndexable {
  return {
    name: "winners",
    kind: "block",
    domain: "winner-blocks",

    startBlock: winnerStartBlock,

    async onBlock(ctx: BlockContext, db: DatabaseAdapter): Promise<void> {
      const e = ctx.events;
      if (e.winner === null) return;

      const winner = e.winner;
      const winningProof = e.proofs.find(
        (p) => p.miner === winner.miner && p.energyMilli === winner.energyMilli,
      );
      // Permanent data conditions, not transient failures: log + treat as
      // processed (matching the old SkippedBlock discipline, blocks.ts:46-62)
      // rather than throwing the block into a forever-retried gap.
      if (!winningProof) {
        console.warn(
          `[pipeline/winners] block #${e.blockNumber}: BlockWinner without matching ProofAccepted; skipping insert`,
        );
        return;
      }
      // A "0" nonce sentinel would collide with the legitimate u64 value 0,
      // so a null nonce is skipped rather than defaulted.
      if (e.nonce === null) {
        console.warn(
          `[pipeline/winners] block #${e.blockNumber}: BlockWinner without recoverable submit_proof nonce; skipping insert`,
        );
        return;
      }

      const [lastProofBlock, qblock, topology, topologyHash] = await Promise.all([
        ctx.lastProofBlockAtParent(),
        ctx.qblock(),
        ctx.topology(),
        ctx.defaultTopologyAt(),
      ]);
      // LastProofBlock is read at the PARENT hash: on_finalize updates it
      // in-block, so the parent's value is the prior tip.
      const miningTimeBlocks = lastProofBlock > 0 ? Math.max(1, e.blockNumber - lastProofBlock) : 0;
      // Runtime-112 qblocks carry the winner's self-reported compute time
      // (QPU access time for QPU wins, wall clock for CPU/GPU), in µs.
      // Prefer it — the derived block-spacing wall clock below remains
      // recomputable from chain data by anyone, so nothing is lost.
      // Falsy (null = pre-112, 0 = unreported) falls back to the spacing.
      const miningTime = qblock?.deviceAccessTimeUs
        ? qblock.deviceAccessTimeUs / 1_000_000
        : miningTimeBlocks * BABE_SLOT_DURATION_SEC;
      // Persisted separately from miningTime (which always has a value, real
      // or derived) so consumers can tell a real report from an estimate.
      // Falsy (null = pre-112, 0 = unreported) both normalize to null — the
      // normal case for most blocks.
      const deviceAccessTimeUs = qblock?.deviceAccessTimeUs ? qblock.deviceAccessTimeUs : null;
      // Post-v0.2 the qblock carries the mined-against difficulty; pre-v0.2
      // winners get the stated sentinel (spec §10.2).
      const difficulty = qblock?.difficulty ?? ZERO_DIFFICULTY;

      const record: BlockRecord = {
        blockHash: e.blockHash,
        substrateBlockNumber: String(e.blockNumber),
        substrateBlockHash: e.blockHash,
        substrateParentHash: e.parentHash,
        timestamp: e.timestamp,
        minerId: winner.miner,
        energy: winner.energyMilli / 1000,
        diversity: winningProof.diversityMilli / 1000,
        numValidSolutions: winningProof.validSolutionCount,
        miningTime,
        reward: winner.reward,
        qblockId: winner.qblockId,
        nonce: e.nonce,
        numNodes: topology.nodeCount,
        numEdges: topology.edgeCount,
        difficultyEnergy: difficulty.maxEnergyMilli / 1000,
        minDiversity: difficulty.minDiversityMilli / 1000,
        minSolutions: difficulty.minSolutions,
        finalized: true, // tip + backfill are both finalized-only
        topologyHash,
        deviceAccessTimeUs,
      };
      await db.insertBlock(record);
    },

    async dropState(db: DatabaseAdapter): Promise<void> {
      await db.deleteAllBlocks();
    },
  };
}
