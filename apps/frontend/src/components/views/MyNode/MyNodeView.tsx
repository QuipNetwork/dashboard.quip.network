// SPDX-License-Identifier: AGPL-3.0-or-later

import { winningSolutionsSolved } from "@/lib/chain-solutions";
import { formatBalance, shortAddress } from "@/lib/format-chain";
import { formatDuration, formatNumber } from "@/lib/format";
import { selectServerNowMs, selectTipBlock, useTelemetryStore } from "@/store/telemetry-store";
import { ChartCard } from "@/components/layout/ChartCard";
import { CurrentAttemptsPanel } from "./CurrentAttemptsPanel";
import { CurrentDifficultyCard } from "./CurrentDifficultyCard";
import { LastSolutionCard } from "./LastSolutionCard";
import { MinerStatsPanel } from "./MinerStatsPanel";
import { NeighborsList } from "./NeighborsList";
import { RecentMiningPanel } from "./RecentMiningPanel";
import { StatTile } from "./StatTile";
import { useMyNode } from "./use-my-node";

export function MyNodeView() {
  const stats = useMyNode();
  const recentDifficulty = useTelemetryStore((s) => s.recentDifficulty);
  const chainHead = useTelemetryStore((s) => s.chainHead);
  const tipBlock = useTelemetryStore(selectTipBlock);
  const recentMiningSubmissions = useTelemetryStore((s) => s.recentMiningSubmissions);
  const currentDispatch = useTelemetryStore((s) => s.currentDispatch);
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const indexer = useTelemetryStore((s) => s.indexer);
  const serverNowMs = useTelemetryStore(selectServerNowMs);
  // Age of the most recent /api/v1/status poll, anchored on the
  // server-stamped `serverTime` so a backgrounded tab can't inflate
  // it via a drifted client clock. Null pre-first-fetch so the panel
  // hides the footer rather than showing "fetched 56yr ago" (1970
  // epoch) on a fresh deploy.
  const dataAgeMs = indexer?.lastStatusFetchAt
    ? Math.max(0, serverNowMs - Date.parse(indexer.lastStatusFetchAt))
    : null;

  if (!stats.selfAddress) {
    return (
      <div className="border border-border bg-white p-12 text-center">
        <p className="font-heading text-2xl text-ink-strong">Connecting to miner…</p>
        <p className="mt-2 font-accent text-sm text-ink-subtle">
          The indexer hasn't discovered the local validator's signer yet, or the operator's node
          descriptor hasn't landed on-chain. Confirm the configured QUIP_VALIDATOR_RPC_URLS point at
          a validator that holds session keys for your account.
        </p>
      </div>
    );
  }

  const {
    selfAddress,
    chainMinerEntry,
    modes,
    lastWonBlock,
    lastWonProblemNumber,
    blocksMined,
    currentRequirements,
    selfAvgMiningTimeSec,
    self,
    neighbors,
    recentSubmissions,
    effectiveMinerStats,
    effectiveProblemsAttempted,
  } = stats;
  const lastWonAgoMs = lastWonBlock != null ? Date.now() - lastWonBlock.timestamp * 1000 : null;
  // Correlate the chain-side winning BlockRecord with the miner-side
  // submission by chain_block_number to pull the winning dispatch's attempt
  // count, which the chain has no equivalent for.
  const lastWonSubmission =
    lastWonBlock != null
      ? recentMiningSubmissions.find(
          (s) => s.chainBlockNumber === lastWonBlock.substrateBlockNumber,
        )
      : undefined;

  return (
    <>
      <div className="flex flex-col gap-1 border border-border bg-white p-5 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <p className="font-accent text-[10px] uppercase tracking-wider text-ink-subtle">
            Connected Node
          </p>
          <h2 className="font-heading text-2xl text-ink-strong">{shortAddress(selfAddress)}</h2>
          <p className="mt-1 font-accent text-xs text-ink-body">{selfAddress}</p>
        </div>
        {chainMinerEntry && (
          <span className="inline-block border border-border px-2 py-1 font-accent text-xs text-ink-body">
            registered · deposit {formatBalance(chainMinerEntry.deposit)}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        <StatTile
          label="Problems Won"
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
          label="Last Problem Won"
          value={
            lastWonBlock != null && lastWonProblemNumber != null
              ? `Problem #${formatNumber(lastWonProblemNumber)}`
              : "—"
          }
          sublabel={
            lastWonBlock != null && lastWonAgoMs != null
              ? `${formatDuration(lastWonAgoMs)} ago · win ${formatNumber(Number(blocksMined))} of yours · block #${lastWonBlock.substrateBlockNumber}`
              : "No wins yet"
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <LastSolutionCard lastWonBlock={lastWonBlock} lastWonSubmission={lastWonSubmission} />
        <CurrentDifficultyCard
          currentRequirements={currentRequirements}
          recentDifficulty={recentDifficulty}
          chainHead={chainHead}
          tipBlock={tipBlock}
        />
      </div>

      <CurrentAttemptsPanel
        dispatch={currentDispatch}
        recentSubmissions={recentMiningSubmissions}
        problemNumber={
          // Mining problem # = LatestQBlockId + 1, sourced from
          // chain via chain_head (see winningSolutionsSolved). Matches both
          // CurrentBlockIndicator's header and the server's currentDispatch
          // probe so all three agree.
          winningSolutionsSolved(chainHead, chainMiners) + 1
        }
        nowMs={Date.now()}
      />

      {effectiveMinerStats && (
        <MinerStatsPanel
          stats={effectiveMinerStats}
          chainMinerEntry={chainMinerEntry}
          selfAvgMiningTimeSec={selfAvgMiningTimeSec}
          problemsAttempted={effectiveProblemsAttempted}
          modes={modes}
          dataAgeMs={dataAgeMs}
        />
      )}

      <RecentMiningPanel submissions={recentSubmissions} nowMs={Date.now()} />

      <ChartCard title="Rank-Adjacent Miners" subtitle="Your position in the network leaderboard">
        <NeighborsList self={self} neighbors={neighbors} />
      </ChartCard>
    </>
  );
}
