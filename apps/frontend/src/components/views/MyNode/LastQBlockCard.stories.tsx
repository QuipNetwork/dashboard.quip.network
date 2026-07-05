import type { Story } from "@ladle/react";

import type { BlockRecord, MiningSubmissionRecord } from "@quip/shared/telemetry";
import { LastQBlockCard } from "./LastQBlockCard";

// LastQBlockCard is a pure-prop component (no store reads), so its story
// just builds fixtures directly — no StoryServices needed.
function block(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return {
    blockHash: "0xblock1042",
    substrateBlockNumber: "1042",
    substrateBlockHash: "0xsub1042",
    substrateParentHash: "0xsub1041",
    timestamp: Math.floor(Date.now() / 1000) - 18,
    minerId: "quantum-rig-01",
    energy: -15420,
    diversity: 0.42,
    numValidSolutions: 2,
    miningTime: 1.2,
    reward: "1000000000000",
    qblockId: "1042",
    nonce: "104200",
    numNodes: 120,
    numEdges: 240,
    difficultyEnergy: -15500,
    minDiversity: 0.1,
    minSolutions: 1,
    topologyHash: null,
    finalized: true,
    deviceAccessTimeUs: null,
    ...overrides,
  };
}

function submission(overrides: Partial<MiningSubmissionRecord> = {}): MiningSubmissionRecord {
  return {
    solutionNumber: 1042,
    minerId: "quantum-rig-01",
    minerType: "QPU",
    tsNs: String(Date.now() * 1_000_000),
    energyMilli: -15420000,
    diversityMilli: 420,
    thresholdMilli: -15500000,
    lastProofBlockHash: "0xproof1042",
    extrinsicHash: "0xext1042",
    chainBlockHash: "0xsub1042",
    chainBlockNumber: "1042",
    powSequence: null,
    outcome: "submitted_inblock",
    attemptCount: 4,
    bestEnergyMilli: -15420000,
    numValid: 2,
    qpuAccessTimeUs: 1200,
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

export const Default: Story = () => (
  <LastQBlockCard
    lastWonBlock={block()}
    lastWonSubmission={submission()}
    lastWonProblemNumber={1042}
  />
);

export const Empty: Story = () => (
  <LastQBlockCard lastWonBlock={null} lastWonSubmission={undefined} lastWonProblemNumber={null} />
);
