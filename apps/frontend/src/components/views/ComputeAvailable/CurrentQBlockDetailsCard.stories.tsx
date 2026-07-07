import type { Story } from "@ladle/react";

import type { BlockRecord, DifficultyRecord } from "@quip/shared/telemetry";
import type { CurrentRequirements } from "@/components/views/MyNode/use-my-node";
import { CurrentQBlockDetailsCard } from "./CurrentQBlockDetailsCard";

// CurrentQBlockDetailsCard is a pure-prop component (no store reads), so its
// story just builds fixtures directly — no StoryServices needed.
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

function difficultyRecord(overrides: Partial<DifficultyRecord> = {}): DifficultyRecord {
  return {
    observedAtBlock: "1040",
    difficultyEnergy: -15500,
    minDiversity: 0.1,
    minSolutions: 1,
    observedAt: new Date().toISOString(),
    topologyHash: null,
    source: "poll",
    ...overrides,
  };
}

const currentDifficulty: CurrentRequirements = {
  difficultyEnergy: -15500,
  minDiversity: 0.1,
  minSolutions: 1,
};

export const Default: Story = () => (
  <CurrentQBlockDetailsCard
    lastBlock={block()}
    currentBlockPflopSeconds={7.4}
    currentBlockElapsedSeconds={22}
    currentDifficulty={currentDifficulty}
    recentDifficulty={[
      difficultyRecord({ observedAtBlock: "1042", difficultyEnergy: -15500 }),
      difficultyRecord({ observedAtBlock: "1039", difficultyEnergy: -15488 }),
      difficultyRecord({ observedAtBlock: "1036", difficultyEnergy: -15476 }),
      difficultyRecord({ observedAtBlock: "1033", difficultyEnergy: -15464 }),
    ]}
    decays={3}
  />
);

export const Empty: Story = () => (
  <CurrentQBlockDetailsCard
    lastBlock={null}
    currentBlockPflopSeconds={null}
    currentBlockElapsedSeconds={null}
    currentDifficulty={null}
    recentDifficulty={[]}
    decays={null}
  />
);
