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

  return useMemo<MyNodeStats>(() => {
    const chainMinerEntry = selfAddress
      ? (chainMiners.find((m) => m.accountId === selfAddress) ?? null)
      : null;
    const lastWonBlock = selfAddress
      ? (blocks.find((b) => b.minerId === selfAddress) ?? null)
      : null;
    const currentRequirements: CurrentRequirements | null = tipBlock
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
  }, [selfAddress, chainMiners, blocks, indexer, tipBlock]);
}
