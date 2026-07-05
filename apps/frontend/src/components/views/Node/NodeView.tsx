// SPDX-License-Identifier: AGPL-3.0-or-later

import { winningSolutionsSolved } from "@/lib/chain-solutions";
import { displayNodeName, formatBalance } from "@/lib/format-chain";
import { formatDuration, formatNumber } from "@/lib/format";
import { selectServerNowMs, selectTipBlock, useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";
import { ChartCard } from "@/components/layout/ChartCard";
import { CurrentAttemptsPanel } from "@/components/views/MyNode/CurrentAttemptsPanel";
import { CurrentDifficultyCard } from "@/components/views/MyNode/CurrentDifficultyCard";
import { LastQBlockCard } from "@/components/views/MyNode/LastQBlockCard";
import { MinerStatsPanel } from "@/components/views/MyNode/MinerStatsPanel";
import { NeighborsList } from "@/components/views/MyNode/NeighborsList";
import { RecentMiningPanel } from "@/components/views/MyNode/RecentMiningPanel";
import { StatTile } from "@/components/views/MyNode/StatTile";
import { useMinerWins } from "@/services/use-miner-wins";
import { useNode } from "./use-node";
import { useNodeLiveData } from "./use-node-live-data";

export function NodeView() {
  const selectedNodeId = useUIStore((s) => s.selectedNodeId);
  const setViewMode = useUIStore((s) => s.setViewMode);
  if (!selectedNodeId) {
    return (
      <div className="border border-border bg-white p-12 text-center">
        <p className="font-heading text-2xl text-ink-strong">No node selected</p>
      </div>
    );
  }
  return <NodeDetail accountId={selectedNodeId} onBack={() => setViewMode("network")} />;
}

function NodeDetail({ accountId, onBack }: { accountId: string; onBack: () => void }) {
  // Shared /api/miner-wins dataset — same table as the leaderboard and
  // rank-neighbor rows, so every win count on this page matches them.
  const minerWins = useMinerWins();
  const node = useNode(accountId, minerWins.rows);
  const live = useNodeLiveData(accountId);
  const recentDifficulty = useTelemetryStore((s) => s.recentDifficulty);
  const chainHead = useTelemetryStore((s) => s.chainHead);
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const tipBlock = useTelemetryStore(selectTipBlock);
  const serverNowMs = useTelemetryStore(selectServerNowMs);

  const {
    chainMinerEntry,
    descriptor,
    lastWonBlock,
    lastWonProblemNumber,
    blocksMined,
    avgMiningTimeSec,
    currentRequirements,
    recentSubmissions,
    self,
    neighbors,
  } = node;

  const name = displayNodeName(accountId, descriptor?.descriptor.nodeName);
  const lastWonAgoMs = lastWonBlock != null ? Date.now() - lastWonBlock.timestamp * 1000 : null;
  const lastWonSubmission =
    lastWonBlock != null
      ? recentSubmissions.find((s) => s.chainBlockNumber === lastWonBlock.substrateBlockNumber)
      : undefined;
  const problemNumber = winningSolutionsSolved(chainHead, chainMiners) + 1;
  const problemsAttempted = Number(chainMinerEntry?.proofsSubmitted ?? "0");
  const liveAgeMs =
    live.data != null ? Math.max(0, serverNowMs - Date.parse(live.data.fetchedAt)) : null;

  return (
    <>
      <div className="flex flex-col gap-1 border border-border bg-white p-5 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <button
            type="button"
            onClick={onBack}
            className="mb-1 cursor-pointer font-accent text-[10px] uppercase tracking-wider text-ink-subtle hover:text-ink-strong"
          >
            ← Back
          </button>
          <h2 className="font-heading text-2xl text-ink-strong">{name}</h2>
          <p className="mt-1 break-all font-accent text-xs text-ink-body">{accountId}</p>
        </div>
        {chainMinerEntry && (
          <span className="inline-block border border-border px-2 py-1 font-accent text-xs text-ink-body">
            registered · deposit {formatBalance(chainMinerEntry.deposit)}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        <StatTile
          label="QBlocks Won"
          value={formatNumber(Number(blocksMined))}
          sublabel={
            chainMinerEntry
              ? `${chainMinerEntry.proofsSubmitted} proofs submitted · chain-confirmed`
              : "Not registered on chain"
          }
        />
        <StatTile
          label="Rewards Earned"
          value={chainMinerEntry ? formatBalance(chainMinerEntry.rewardsEarned) : "—"}
          sublabel={chainMinerEntry ? "lifetime, on-chain" : "Awaiting first win"}
        />
        <StatTile
          label="Last QBlock Won"
          value={
            lastWonBlock != null && lastWonProblemNumber != null
              ? `QBlock #${formatNumber(lastWonProblemNumber)}`
              : "—"
          }
          sublabel={
            lastWonBlock != null && lastWonAgoMs != null
              ? `${formatDuration(lastWonAgoMs)} ago · block #${lastWonBlock.substrateBlockNumber}`
              : "No wins yet"
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <LastQBlockCard
          lastWonBlock={lastWonBlock}
          lastWonSubmission={lastWonSubmission}
          lastWonProblemNumber={lastWonProblemNumber}
        />
        <CurrentDifficultyCard
          currentRequirements={currentRequirements}
          recentDifficulty={recentDifficulty}
          chainHead={chainHead}
          tipBlock={tipBlock}
        />
      </div>

      {/* Live sections require direct RPC to the node; they degrade to a
          notice when the peer is unreachable. */}
      {live.status === "loading" && <LiveNotice message={`Fetching live data from ${name}…`} />}
      {live.status === "unreachable" && (
        <LiveNotice
          message="Node data unreachable"
          detail={`${name} did not respond to a live data request. It may be offline, firewalled, or not publishing a reachable host in its on-chain descriptor. Chain-derived stats above remain accurate.`}
        />
      )}
      {live.status === "ok" && live.data != null && (
        <>
          <CurrentAttemptsPanel
            dispatch={live.data.currentDispatch}
            recentSubmissions={recentSubmissions}
            problemNumber={problemNumber}
            nowMs={Date.now()}
          />
          {live.data.minerStats && (
            <MinerStatsPanel
              stats={live.data.minerStats}
              chainMinerEntry={chainMinerEntry}
              selfAvgMiningTimeSec={avgMiningTimeSec}
              problemsAttempted={problemsAttempted}
              modes={live.data.modes}
              dataAgeMs={liveAgeMs}
            />
          )}
        </>
      )}

      <RecentMiningPanel submissions={recentSubmissions} nowMs={Date.now()} />

      <ChartCard title="Rank-Adjacent Miners" subtitle="This node's position in the leaderboard">
        <NeighborsList self={self} neighbors={neighbors} />
      </ChartCard>
    </>
  );
}

function LiveNotice({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="border border-border bg-white p-6">
      <p className="font-heading text-lg text-ink-strong">{message}</p>
      {detail && <p className="mt-2 font-accent text-sm text-ink-subtle">{detail}</p>}
    </div>
  );
}
