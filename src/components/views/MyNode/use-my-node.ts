// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";

import { selectTipBlock, useTelemetryStore } from "../../../store/telemetry-store";
import type { BlockRecord, ChainMinerRecord, MinerStats } from "../../../types/telemetry";

export interface CurrentRequirements {
  difficultyEnergy: number;
  minDiversity: number;
  minSolutions: number;
}

export interface MyNodeStats {
  selfAddress: string | null;
  chainMinerEntry: ChainMinerRecord | null;
  minerStats: MinerStats | null;
  lastWonBlock: BlockRecord | null;
  // Total blocks won by self (from chain_miners.proofsWon, u64 string-safe).
  blocksMined: string;
  currentRequirements: CurrentRequirements | null;
}

export function useMyNode(): MyNodeStats {
  const selfAddress = useTelemetryStore((s) => s.selfAddress);
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const blocks = useTelemetryStore((s) => s.blocks);
  const indexer = useTelemetryStore((s) => s.indexer);
  const tipBlock = useTelemetryStore(selectTipBlock);
  // Most recent `current_difficulty()` poll. With quip-protocol-rs v0.2 this
  // is the runtime API call that returns the decayed live threshold the
  // pallet currently checks proofs against — fresher than tipBlock's
  // per-block snapshot, which can be the threshold from a winning proof
  // many hours ago. Survives wipe-on-drift restarts where `blocks` starts
  // empty but the indexer's first difficulty poll fires within 300s.
  const recentDifficulty = useTelemetryStore((s) => s.recentDifficulty);

  return useMemo<MyNodeStats>(() => {
    const chainMinerEntry = selfAddress
      ? (chainMiners.find((m) => m.accountId === selfAddress) ?? null)
      : null;
    const lastWonBlock = selfAddress
      ? (blocks.find((b) => b.minerId === selfAddress) ?? null)
      : null;
    const liveDifficulty = recentDifficulty[0] ?? null;
    const currentRequirements: CurrentRequirements | null = liveDifficulty
      ? {
          difficultyEnergy: liveDifficulty.difficultyEnergy,
          minDiversity: liveDifficulty.minDiversity,
          minSolutions: liveDifficulty.minSolutions,
        }
      : tipBlock
        ? {
            difficultyEnergy: tipBlock.difficultyEnergy,
            minDiversity: tipBlock.minDiversity,
            minSolutions: tipBlock.minSolutions,
          }
        : null;
    return {
      selfAddress,
      chainMinerEntry,
      minerStats: indexer?.minerStats ?? null,
      lastWonBlock,
      blocksMined: chainMinerEntry?.proofsWon ?? "0",
      currentRequirements,
    };
  }, [selfAddress, chainMiners, blocks, indexer, tipBlock, recentDifficulty]);
}
