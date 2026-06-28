import type { Story } from "@ladle/react";

import { StoryServices } from "@/testing/services";
import type { BlockRecord, IndexerObservability } from "@quip/shared/telemetry";
import { SyncIndicator } from "./SyncIndicator";

const nowMs = Date.now();
const iso = (msAgo: number) => new Date(nowMs - msAgo).toISOString();

function observability(overrides: Partial<IndexerObservability> = {}): IndexerObservability {
  return {
    chainHeadFromNode: "1042",
    lastStatusFetchAt: iso(8_000),
    lastBlockInsertAt: iso(8_000),
    lastSubstrateEventAt: iso(8_000),
    bestBlockHeight: "1042",
    finalizedBlockHeight: "1039",
    chainConnected: true,
    minerStats: null,
    modes: {},
    ...overrides,
  };
}

function recentBlock(): BlockRecord {
  return {
    blockHash: "0xabc",
    substrateBlockNumber: "1042",
    substrateBlockHash: "0xsub",
    substrateParentHash: "0xparent",
    timestamp: Math.floor((nowMs - 5_000) / 1000),
    minerId: "qpu-1.carback",
    energy: -15200,
    diversity: 0.5,
    numValidSolutions: 1,
    miningTime: 3.2,
    reward: "1000000000000",
    qblockId: "1",
    nonce: "1",
    numNodes: 100,
    numEdges: 200,
    difficultyEnergy: -15300,
    minDiversity: 0.1,
    minSolutions: 1,
    finalized: true,
  };
}

export const Connecting: Story = () => (
  <StoryServices telemetry={{ loading: false, indexer: null }}>
    <SyncIndicator />
  </StoryServices>
);

export const Live: Story = () => (
  <StoryServices
    telemetry={{
      loading: false,
      serverTime: new Date(nowMs).toISOString(),
      indexer: observability(),
      blocks: [recentBlock()],
    }}
  >
    <SyncIndicator />
  </StoryServices>
);

export const IndexerOffline: Story = () => (
  <StoryServices
    telemetry={{
      loading: false,
      serverTime: new Date(nowMs).toISOString(),
      indexer: observability({ lastStatusFetchAt: iso(7 * 60_000) }),
      blocks: [recentBlock()],
    }}
  >
    <SyncIndicator />
  </StoryServices>
);
