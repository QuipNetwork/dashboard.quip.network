// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatBalance, shortAddress } from "../../../lib/format-chain";
import { formatDuration, formatNumber } from "../../../lib/format";
import { ChartCard } from "../../layout/ChartCard";
import { BlockDetailCard } from "./BlockDetailCard";
import { useMyNode } from "./use-my-node";
import { StatTile } from "./StatTile";
import { MinerStatsPanel } from "./MinerStatsPanel";
import { NeighborsList } from "./NeighborsList";

export function MyNodeView() {
  const stats = useMyNode();

  if (!stats.selfAddress) {
    return (
      <div className="rounded-xl border border-brand-gray-2 bg-brand-gray-1/40 p-12 text-center backdrop-blur-xl">
        <p className="font-heading text-2xl text-brand-gray-5">Connecting to miner…</p>
        <p className="mt-2 font-accent text-sm text-brand-gray-3">
          The indexer hasn't received a response from /api/v1/status yet. Verify QUIP_NODE_URL is
          reachable.
        </p>
      </div>
    );
  }

  const {
    selfAddress,
    chainMinerEntry,
    minerStats,
    lastWonBlock,
    blocksMined,
    currentRequirements,
    self,
    neighbors,
  } = stats;
  const lastWonAgoMs = lastWonBlock != null ? Date.now() - lastWonBlock.timestamp * 1000 : null;
  // BABE slot duration on quip-protocol-rs is 6s; api.consts.babe.slotDuration
  // would be the authoritative source but isn't currently piped through
  // telemetry. Use the constant until that wiring exists — slot duration
  // is a runtime constant, not data-derived, so this is stable across blocks.
  const blockTimeSec = 6;
  const lastSolutionTimeMs =
    lastWonBlock != null ? lastWonBlock.miningTime * blockTimeSec * 1000 : null;
  // "Not enforced" reads better than literal "0" when the chain difficulty
  // requirements aren't gated on a given dimension (most quip configs leave
  // diversity / solutions / quality at 0 today).
  const notEnforced = <span className="text-brand-gray-3 italic">not enforced</span>;

  return (
    <>
      <div className="mb-5 flex flex-col gap-1 rounded-xl border border-brand-gray-2 bg-brand-gray-1/40 p-5 backdrop-blur-xl sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <p className="font-accent text-[10px] uppercase tracking-wider text-brand-gray-3">
            Connected Node
          </p>
          <h2 className="font-heading text-2xl text-brand-gray-6">{shortAddress(selfAddress)}</h2>
          <p className="mt-1 font-accent text-xs text-brand-gray-4">{selfAddress}</p>
        </div>
        {chainMinerEntry && (
          <span className="inline-block rounded-md border border-brand-gray-2 px-2 py-1 font-accent text-xs text-brand-gray-4">
            registered · deposit {formatBalance(chainMinerEntry.deposit)}
          </span>
        )}
      </div>

      <div className="mb-5 grid grid-cols-1 gap-5 sm:grid-cols-3">
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
          value={lastWonBlock != null ? `Solution #${formatNumber(Number(blocksMined))}` : "—"}
          sublabel={
            lastWonBlock != null && lastWonAgoMs != null
              ? `${formatDuration(lastWonAgoMs)} ago · at block #${lastWonBlock.substrateBlockNumber}`
              : "No wins yet"
          }
        />
      </div>

      <div className="mb-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
        <BlockDetailCard
          label="Last Problem Solution Details"
          rows={
            lastWonBlock != null
              ? [
                  {
                    label: "Time to Solution",
                    value:
                      lastSolutionTimeMs != null && lastSolutionTimeMs > 0
                        ? `${formatDuration(lastSolutionTimeMs)} · ${lastWonBlock.miningTime} blocks`
                        : "—",
                  },
                  {
                    label: "Attempts",
                    value: <span className="text-brand-gray-3 italic">TBD · miner API</span>,
                  },
                  { label: "Energy", value: lastWonBlock.energy.toFixed(2) },
                  { label: "Diversity", value: lastWonBlock.diversity.toFixed(3) },
                  { label: "Solutions", value: formatNumber(lastWonBlock.numValidSolutions) },
                  { label: "Reward", value: formatBalance(lastWonBlock.reward) },
                ]
              : [{ label: "Status", value: "No wins yet" }]
          }
          footer={
            lastWonBlock
              ? `block #${lastWonBlock.substrateBlockNumber} · nonce: ${lastWonBlock.nonce}`
              : undefined
          }
        />
        <BlockDetailCard
          label="Current Difficulty"
          rows={
            currentRequirements != null
              ? [
                  {
                    label: "Target Energy",
                    value: `≤ ${currentRequirements.difficultyEnergy.toFixed(3)}`,
                  },
                  {
                    label: "Min Diversity",
                    value:
                      currentRequirements.minDiversity > 0
                        ? currentRequirements.minDiversity.toFixed(3)
                        : notEnforced,
                  },
                  {
                    label: "Min Solutions",
                    value:
                      currentRequirements.minSolutions > 0
                        ? formatNumber(currentRequirements.minSolutions)
                        : notEnforced,
                  },
                ]
              : [{ label: "Status", value: "Awaiting first block" }]
          }
        />
      </div>

      {minerStats && <MinerStatsPanel stats={minerStats} chainMinerEntry={chainMinerEntry} />}

      <ChartCard title="Rank-Adjacent Miners" subtitle="Your position in the network leaderboard">
        <NeighborsList self={self} neighbors={neighbors} />
      </ChartCard>
    </>
  );
}
