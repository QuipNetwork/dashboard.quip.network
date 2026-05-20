// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatBalance, shortAddress } from "../../../lib/format-chain";
import { formatDuration, formatNumber } from "../../../lib/format";
import { BlockDetailCard } from "./BlockDetailCard";
import { useMyNode } from "./use-my-node";
import { StatTile } from "./StatTile";
import { MinerStatsPanel } from "./MinerStatsPanel";

export function MyNodeView() {
  const stats = useMyNode();

  if (!stats.selfAddress) {
    return (
      <div className="rounded-xl border border-brand-gray-2 bg-brand-gray-1/40 p-12 text-center backdrop-blur-xl">
        <p className="font-heading text-2xl text-brand-gray-5">Connecting to node…</p>
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
  } = stats;
  const lastWonAgoMs = lastWonBlock != null ? Date.now() - lastWonBlock.timestamp * 1000 : null;

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
          label="Blocks Won"
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
          label="Last Block Won"
          value={lastWonBlock != null ? `#${lastWonBlock.substrateBlockNumber}` : "—"}
          sublabel={
            lastWonBlock != null && lastWonAgoMs != null
              ? `${formatDuration(lastWonAgoMs)} ago · mining time ${lastWonBlock.miningTime} blocks`
              : "No wins yet"
          }
        />
      </div>

      <div className="mb-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
        <BlockDetailCard
          label="Last Won Block Details"
          rows={
            lastWonBlock != null
              ? [
                  { label: "Energy", value: lastWonBlock.energy.toFixed(2) },
                  { label: "Diversity", value: lastWonBlock.diversity.toFixed(3) },
                  { label: "Solutions", value: formatNumber(lastWonBlock.numValidSolutions) },
                  { label: "Quality", value: (lastWonBlock.qualityMilli / 1000).toFixed(3) },
                  { label: "Reward", value: formatBalance(lastWonBlock.reward) },
                ]
              : [{ label: "Status", value: "No wins yet" }]
          }
          footer={lastWonBlock ? `nonce: ${lastWonBlock.nonce}` : undefined}
        />
        <BlockDetailCard
          label="Current Difficulty"
          rows={
            currentRequirements != null
              ? [
                  {
                    label: "Target Energy",
                    value: `≤ ${currentRequirements.difficultyEnergy.toFixed(1)}`,
                  },
                  { label: "Min Diversity", value: currentRequirements.minDiversity.toFixed(3) },
                  { label: "Min Solutions", value: formatNumber(currentRequirements.minSolutions) },
                ]
              : [{ label: "Status", value: "Awaiting first block" }]
          }
        />
      </div>

      {minerStats && <MinerStatsPanel stats={minerStats} />}
    </>
  );
}
