import type { Story } from "@ladle/react";

import type { BlockRecord } from "@quip/shared/telemetry";
import { LastQBlockDetailsCard } from "./LastQBlockDetailsCard";

// LastQBlockDetailsCard is a pure-prop component (no store reads), so its
// story just builds a BlockRecord fixture directly — no StoryServices needed.
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

export const Default: Story = () => (
  <LastQBlockDetailsCard lastBlock={block()} lastBlockPflopSeconds={42.7} />
);

export const Empty: Story = () => (
  <LastQBlockDetailsCard lastBlock={null} lastBlockPflopSeconds={null} />
);
