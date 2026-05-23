// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatBalance, formatNonce, shortAddress } from "../../../lib/format-chain";
import { formatDuration, formatNumber } from "../../../lib/format";
import { selectTipBlock, useTelemetryStore } from "../../../store/telemetry-store";
import { ChartCard } from "../../layout/ChartCard";
import { BlockDetailCard, type DetailRow } from "./BlockDetailCard";
import { useMyNode } from "./use-my-node";
import { StatTile } from "./StatTile";
import { CurrentAttemptsPanel } from "./CurrentAttemptsPanel";
import { MinerStatsPanel } from "./MinerStatsPanel";
import { NeighborsList } from "./NeighborsList";
import { RecentMiningPanel } from "./RecentMiningPanel";

// quip-protocol-rs `apply_decay` applies one decay step per `EpochLength`
// blocks past `LastProofBlock`. Hard-coded to match `QuantumPowEpochLength
// = 100` on spec 101 — same constant + caveat as `CurrentBlockIndicator`
// and `ComputeAvailableView`.
const QUANTUM_POW_EPOCH_LENGTH = 100;
// Cap the "Prior energy" rows on the Current Difficulty card. Three
// reads as a clear trail without growing the card past a screenful;
// adjustment changes affect every poll so showing more is mostly noise.
const PRIOR_ENERGY_ROWS = 3;

export function MyNodeView() {
  const stats = useMyNode();
  const recentDifficulty = useTelemetryStore((s) => s.recentDifficulty);
  const chainHead = useTelemetryStore((s) => s.chainHead);
  const tipBlock = useTelemetryStore(selectTipBlock);
  const recentMiningSubmissions = useTelemetryStore((s) => s.recentMiningSubmissions);
  const currentDispatch = useTelemetryStore((s) => s.currentDispatch);
  const chainMiners = useTelemetryStore((s) => s.chainMiners);

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
  // `miningTime` is in seconds (substrate-worker converts the block-delta
  // via BABE slot duration before writing). The "X blocks" supplementary
  // display below divides back by the slot duration; if the runtime
  // constant is ever piped through telemetry, derive both from the same
  // source.
  const blockTimeSec = 6;
  const lastSolutionTimeMs = lastWonBlock != null ? lastWonBlock.miningTime * 1000 : null;
  const lastSolutionBlocks =
    lastWonBlock != null ? Math.round(lastWonBlock.miningTime / blockTimeSec) : null;
  // Correlate the chain-side winning BlockRecord with the miner-side
  // submission by chain_block_number — every successful submission has
  // chain_block_number set to the block where it landed. Lets us pull
  // the attempt count for the winning dispatch from the miner's
  // controller, which the chain has no equivalent for.
  const lastWonSubmission =
    lastWonBlock != null
      ? recentMiningSubmissions.find(
          (s) => s.chainBlockNumber === lastWonBlock.substrateBlockNumber,
        )
      : undefined;
  // "Not enforced" reads better than literal "0" when the chain difficulty
  // requirements aren't gated on a given dimension (most quip configs leave
  // diversity / solutions / quality at 0 today).
  const notEnforced = <span className="text-brand-gray-3 italic">not enforced</span>;

  // Decay step count and the trail of recent prior energies. Decays are
  // derived from (finalized - lastProofBlock) / EpochLength so the value
  // matches what the pallet's `apply_decay` would compute. The trail is
  // up to PRIOR_ENERGY_ROWS distinct-energy entries from recentDifficulty,
  // skipping the most recent (which is shown as the current threshold).
  const finalizedNum =
    chainHead && chainHead.finalizedBlockNumber ? Number(chainHead.finalizedBlockNumber) : null;
  const lastProofBlockNum = tipBlock ? Number(tipBlock.substrateBlockNumber) : null;
  const decaysApplied =
    finalizedNum != null && lastProofBlockNum != null
      ? Math.max(0, Math.floor((finalizedNum - lastProofBlockNum) / QUANTUM_POW_EPOCH_LENGTH))
      : null;
  const priorEnergies: Array<{ block: string; energy: number }> = [];
  if (recentDifficulty.length > 1) {
    const seen = new Set<number>();
    // recentDifficulty arrives newest-first; index 0 is the current poll
    // and already surfaces on the Target Energy row.
    for (let i = 1; i < recentDifficulty.length && priorEnergies.length < PRIOR_ENERGY_ROWS; i++) {
      const r = recentDifficulty[i]!;
      if (seen.has(r.difficultyEnergy)) continue;
      seen.add(r.difficultyEnergy);
      priorEnergies.push({ block: r.observedAtBlock, energy: r.difficultyEnergy });
    }
  }

  const difficultyRows: DetailRow[] =
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
          ...(decaysApplied != null
            ? [
                {
                  label: "Decays Applied",
                  value: formatNumber(decaysApplied),
                } satisfies DetailRow,
              ]
            : []),
          ...priorEnergies.map(
            (p): DetailRow => ({
              label: `Prior @ #${p.block}`,
              value: `≤ ${p.energy.toFixed(3)}`,
            }),
          ),
        ]
      : [{ label: "Status", value: "Awaiting first block" }];

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
                        ? `${formatDuration(lastSolutionTimeMs)} · ${lastSolutionBlocks} blocks`
                        : "—",
                  },
                  {
                    label: "Attempts",
                    value:
                      lastWonSubmission != null
                        ? formatNumber(lastWonSubmission.attemptCount)
                        : "—",
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
              ? `block #${lastWonBlock.substrateBlockNumber} · nonce: ${formatNonce(lastWonBlock.nonce)}`
              : undefined
          }
        />
        <BlockDetailCard label="Current Difficulty" rows={difficultyRows} />
      </div>

      <CurrentAttemptsPanel
        dispatch={currentDispatch}
        recentSubmissions={recentMiningSubmissions}
        problemNumber={
          // Mining problem # = total proofs ever won (across all miners) + 1.
          // Matches CurrentBlockIndicator's `nextProblem` derivation so the
          // panel header agrees with the header indicator.
          chainMiners.reduce((sum, m) => sum + Number(m.proofsWon || "0"), 0) + 1
        }
        nowMs={Date.now()}
      />

      {minerStats && <MinerStatsPanel stats={minerStats} chainMinerEntry={chainMinerEntry} />}

      <RecentMiningPanel submissions={recentMiningSubmissions} nowMs={Date.now()} />

      <ChartCard title="Rank-Adjacent Miners" subtitle="Your position in the network leaderboard">
        <NeighborsList self={self} neighbors={neighbors} />
      </ChartCard>
    </>
  );
}
