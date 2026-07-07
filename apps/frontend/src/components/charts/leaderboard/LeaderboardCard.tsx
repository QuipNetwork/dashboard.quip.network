// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Self-contained "Mining Leaderboard" card: owns its ChartCard, the
// By Count | By Energy | By Time toggle, and the mode-aware ranking
// (leaderboard-modes.ts).

import { useMemo, useState } from "react";

import { SegmentedControl } from "@/components/charts/common/SegmentedControl";
import { ChartCard } from "@/components/layout/ChartCard";
import { useTelemetryStore } from "@/store/telemetry-store";
import { Leaderboard } from "./Leaderboard";
import {
  applyLeaderboardMode,
  computeMinerTimeEnergyTotals,
  LEADERBOARD_MODES,
  withTimeEnergyTotals,
  type LeaderboardMode,
} from "./leaderboard-modes";
import { useLeaderboard } from "./use-leaderboard";

// By Time/By Energy can only total what the indexer has decoded so far, not
// a miner's lifetime — the subtitle must say so (wu14-brief.md R3).
const SUBTITLES: Record<LeaderboardMode, string> = {
  byCount: "Lifetime qblocks won, from on-chain proofs_won",
  byTime: "Total device-access time across indexed qblocks — not a lifetime figure",
  byEnergy: "Estimated energy to mine, summed across indexed qblocks — not a lifetime figure",
};

export function LeaderboardCard() {
  const [mode, setMode] = useState<LeaderboardMode>("byCount");
  const baseEntries = useLeaderboard();
  const blocks = useTelemetryStore((s) => s.blocks);
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const nodes = useTelemetryStore((s) => s.nodes);

  const entries = useMemo(() => {
    const totals = computeMinerTimeEnergyTotals(blocks, chainMiners, nodeDescriptors, nodes);
    return applyLeaderboardMode(withTimeEnergyTotals(baseEntries, totals), mode);
  }, [baseEntries, blocks, chainMiners, nodeDescriptors, nodes, mode]);

  return (
    <ChartCard
      title="Mining Leaderboard"
      subtitle={SUBTITLES[mode]}
      actions={
        <SegmentedControl
          options={LEADERBOARD_MODES}
          value={mode}
          onChange={setMode}
          ariaLabel="Leaderboard mode"
        />
      }
    >
      <Leaderboard data={entries} mode={mode} />
    </ChartCard>
  );
}
