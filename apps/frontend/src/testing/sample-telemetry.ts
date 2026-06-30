// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TelemetryState } from "@/store/telemetry-store";
import type {
  BabeAuthorityRecord,
  BlockRecord,
  ChainMinerRecord,
  CurrentDispatch,
  DifficultyRecord,
  IndexerObservability,
  MineableTopologyRecord,
  MinerCategory,
  MiningSubmissionRecord,
  NodeDescriptorRecord,
  NodeInfo,
  NodesSnapshot,
  ValidatorAuthorshipRecord,
} from "@quip/shared/telemetry";

interface SampleMiner {
  account: string;
  nodeId: string;
  name: string;
  type: MinerCategory;
  cpuBrand: string;
  cpuCores: number;
  gpus: string[];
  quipVersion: string;
  location: { country: string; city: string; lat: number; lng: number };
}

const MINERS: SampleMiner[] = [
  {
    account: "5Gq1QPUaXmZ8Y27pVbdQ4nF3rZxK1sWcT9hLpN2mJ6vBqD7",
    nodeId: "quantum-rig-01",
    name: "quantum-rig-01",
    type: "QPU",
    cpuBrand: "Intel Xeon Gold 6338",
    cpuCores: 16,
    gpus: [],
    quipVersion: "0.3.1",
    location: { country: "US", city: "San Francisco", lat: 37.77, lng: -122.42 },
  },
  {
    account: "5Gp2GPUbYnA9Z38qWceR5oG4sAyL2tXdU0iMqO3nK7wCrE8",
    nodeId: "gpu-farm-alpha",
    name: "gpu-farm-alpha",
    type: "GPU",
    cpuBrand: "AMD EPYC 7763",
    cpuCores: 64,
    gpus: ["NVIDIA RTX 4090", "NVIDIA RTX 4090"],
    quipVersion: "0.3.1",
    location: { country: "DE", city: "Frankfurt", lat: 50.11, lng: 8.68 },
  },
  {
    account: "5Gr3GPUcZoB0a49rXdfS6pH5tBzM3uYeV1jNrP4oL8xDsF9",
    nodeId: "gpu-farm-beta",
    name: "gpu-farm-beta",
    type: "GPU",
    cpuBrand: "AMD Ryzen 9 7950X",
    cpuCores: 32,
    gpus: ["NVIDIA A100"],
    quipVersion: "0.3.0",
    location: { country: "SG", city: "Singapore", lat: 1.35, lng: 103.82 },
  },
  {
    account: "5Gs4CPUdApC1b50sYegT7qI6uCaN4vZfW2kOsQ5pM9yEtG0",
    nodeId: "epyc-node-01",
    name: "epyc-node-01",
    type: "CPU",
    cpuBrand: "AMD EPYC 9654",
    cpuCores: 96,
    gpus: [],
    quipVersion: "0.3.1",
    location: { country: "GB", city: "London", lat: 51.51, lng: -0.13 },
  },
  {
    account: "5Gt5CPUeBqD2c61tZfhU8rJ7vDbO5wAgX3lPtR6qN0zFuH1",
    nodeId: "xeon-node-02",
    name: "xeon-node-02",
    type: "CPU",
    cpuBrand: "Intel Xeon Platinum 8480",
    cpuCores: 56,
    gpus: [],
    quipVersion: "0.2.9",
    location: { country: "JP", city: "Tokyo", lat: 35.68, lng: 139.69 },
  },
];

const SELF = MINERS[0]!;

const WINNER_SEQUENCE: MinerCategory[] = [
  "QPU",
  "GPU",
  "QPU",
  "QPU",
  "GPU",
  "CPU",
  "QPU",
  "GPU",
  "QPU",
  "QPU",
  "GPU",
  "QPU",
  "CPU",
  "QPU",
  "GPU",
  "QPU",
  "QPU",
  "GPU",
  "CPU",
  "QPU",
  "QPU",
  "GPU",
  "QPU",
  "CPU",
];

const ENERGY_BY_TYPE: Record<MinerCategory, number> = {
  QPU: -15400,
  GPU: -15100,
  CPU: -14800,
  OTHER: -14500,
};

const MINING_TIME_BY_TYPE: Record<MinerCategory, number> = {
  QPU: 1.2,
  GPU: 3.6,
  CPU: 215,
  OTHER: 320,
};

function minerOfType(type: MinerCategory, salt: number): SampleMiner {
  const pool = MINERS.filter((m) => m.type === type);
  return pool[salt % pool.length] ?? SELF;
}

function buildBlocks(nowSec: number): BlockRecord[] {
  const tipNumber = 1042;
  return WINNER_SEQUENCE.map((type, i) => {
    const miner = minerOfType(type, i);
    const jitter = ((i * 37) % 11) / 10;
    const energy = ENERGY_BY_TYPE[type] + ((i * 13) % 90);
    return {
      blockHash: `0xblock${(tipNumber - i).toString(16)}`,
      substrateBlockNumber: String(tipNumber - i),
      substrateBlockHash: `0xsub${(tipNumber - i).toString(16)}`,
      substrateParentHash: `0xsub${(tipNumber - i - 1).toString(16)}`,
      timestamp: nowSec - i * 18,
      minerId: miner.account,
      energy,
      diversity: 0.35 + jitter / 10,
      numValidSolutions: 1 + (i % 3),
      miningTime: MINING_TIME_BY_TYPE[type] + jitter,
      reward: "1000000000000",
      qblockId: String(tipNumber - i),
      nonce: String(100000 + i),
      numNodes: 120 + i,
      numEdges: 240 + i * 2,
      difficultyEnergy: -15500,
      minDiversity: 0.1,
      minSolutions: 1,
      topologyHash: null,
      finalized: i > 2,
    };
  });
}

function buildChainMiners(blocks: readonly BlockRecord[]): ChainMinerRecord[] {
  const winsByAccount = new Map<string, number>();
  for (const b of blocks) winsByAccount.set(b.minerId, (winsByAccount.get(b.minerId) ?? 0) + 1);
  return MINERS.map((m, i) => ({
    accountId: m.account,
    deposit: "1000000000000",
    proofsSubmitted: String(40 + i * 7),
    proofsWon: String(winsByAccount.get(m.account) ?? 0),
    rewardsEarned: String((6 - i) * 1000000000000),
    telemetryNodeAddress: m.nodeId,
    hardware: {
      accountId: m.account,
      nodeId: m.nodeId,
      miners: [{ id: `${m.nodeId}-${m.type}-1`, type: m.type }],
      primaryType: m.type,
      source: "self",
      observedAt: new Date().toISOString(),
    },
  }));
}

function buildNodeDescriptors(nowSec: number): NodeDescriptorRecord[] {
  return MINERS.map((m, i) => ({
    accountId: m.account,
    blockNumber: String(1000 - i),
    blockHash: `0xdesc${i}`,
    extrinsicIndex: 2,
    blockTimestamp: nowSec - 3600,
    firstBlockTimestamp: nowSec - 86400,
    observedAt: new Date().toISOString(),
    descriptor: {
      schema: "quip.node_descriptor.v1",
      descriptorVersion: 1,
      nodeName: m.name,
      publicHost: `${m.nodeId}.quip.network`,
      autoMine: true,
      runtime: { quipVersion: m.quipVersion, inDocker: true },
      miners: Object.fromEntries(
        [[`${m.nodeId}-${m.type}-1`, { kind: m.type, minerId: `${m.nodeId}-${m.type}-1` }]].concat(
          m.gpus.length > 1
            ? [[`${m.nodeId}-${m.type}-2`, { kind: m.type, minerId: `${m.nodeId}-${m.type}-2` }]]
            : [],
        ),
      ),
      systemInfo: {
        os: { system: "Linux", release: "6.8.0", machine: "x86_64" },
        cpu: { brand: m.cpuBrand, logicalCores: m.cpuCores, physicalCores: m.cpuCores / 2 },
        memoryMb: 131072,
        gpus: m.gpus.map((name, gi) => ({ index: gi, vendor: "NVIDIA", name, memoryMb: 24576 })),
      },
    },
  }));
}

function buildNodes(nowSec: number): NodesSnapshot {
  const nodes: Record<string, NodeInfo> = {};
  for (const m of MINERS) {
    nodes[m.nodeId] = {
      address: m.nodeId,
      status: "active",
      firstSeen: nowSec - 86400,
      lastSeen: nowSec - 12,
      lastHeartbeat: nowSec - 12,
      nodeName: m.name,
      publicHost: `${m.nodeId}.quip.network`,
      autoMine: true,
      runtime: { quipVersion: m.quipVersion, inDocker: true },
      systemInfo: {
        os: { system: "Linux", release: "6.8.0", machine: "x86_64" },
        cpu: { brand: m.cpuBrand, logicalCores: m.cpuCores, physicalCores: m.cpuCores / 2 },
        memoryMb: 131072,
        gpus: m.gpus.map((name, gi) => ({ index: gi, vendor: "NVIDIA", name, memoryMb: 24576 })),
      },
      location: m.location,
    };
  }
  return {
    updatedAt: new Date().toISOString(),
    nodeCount: MINERS.length,
    activeCount: MINERS.length,
    nodes,
  };
}

function buildRecentSubmissions(nowSec: number): MiningSubmissionRecord[] {
  return Array.from({ length: 6 }, (_, i) => ({
    solutionNumber: 1042 - i,
    minerId: SELF.account,
    minerType: "QPU",
    tsNs: String((nowSec - i * 18) * 1_000_000_000),
    energyMilli: -15400000 + i * 50000,
    diversityMilli: 380,
    thresholdMilli: -15500000,
    lastProofBlockHash: `0xproof${i}`,
    extrinsicHash: i % 2 === 0 ? `0xext${i}` : null,
    chainBlockHash: `0xsub${(1042 - i).toString(16)}`,
    chainBlockNumber: String(1042 - i),
    powSequence: null,
    outcome: "submitted_inblock",
    attemptCount: 3 + (i % 4),
    bestEnergyMilli: -15400000 + i * 50000,
    numValid: 1,
    qpuAccessTimeUs: 1200,
    observedAt: new Date().toISOString(),
  }));
}

function buildCurrentDispatch(): CurrentDispatch {
  return {
    solutionNumber: 1043,
    status: "in-flight",
    attempts: Array.from({ length: 5 }, (_, i) => ({
      iter: i + 1,
      bestEnergyMilli: -15200000 - i * 40000,
      resultKind: i === 4 ? "submitted" : "stored",
      minerType: "QPU",
      extra: {},
    })),
  };
}

function buildValidators(nowSec: number): ValidatorAuthorshipRecord[] {
  return [
    "5Val1AuthorityNodeAlphaXXXXXXXXXXXXXXXXXXXXXXXXX",
    "5Val2AuthorityNodeBetaXXXXXXXXXXXXXXXXXXXXXXXXXX",
  ].map((accountId, i) => ({
    accountId,
    blocksAuthored: 1240 - i * 130,
    blocksAuthoredWithPow: 24 - i * 5,
    lastAuthoredBlock: String(1042 - i),
    lastAuthoredAt: new Date((nowSec - i * 12) * 1000).toISOString(),
    online: true,
  }));
}

function buildBabeAuthorities(): BabeAuthorityRecord[] {
  return [
    {
      accountId: "5Val1AuthorityNodeAlphaXXXXXXXXXXXXXXXXXXXXXXXXX",
      displayName: "validator-alpha",
    },
    {
      accountId: "5Val2AuthorityNodeBetaXXXXXXXXXXXXXXXXXXXXXXXXXX",
      displayName: "validator-beta",
    },
  ];
}

function buildDifficulty(): DifficultyRecord[] {
  return Array.from({ length: 12 }, (_, i) => ({
    observedAtBlock: String(1042 - i * 3),
    difficultyEnergy: -15500 + i * 12,
    minDiversity: 0.1,
    minSolutions: 1,
    observedAt: new Date().toISOString(),
    topologyHash: null,
  }));
}

function buildMineableTopologies(): MineableTopologyRecord[] {
  return [
    {
      topologyHash: "0xtopo-default",
      isDefault: true,
      difficultyEnergy: -15500,
      minDiversity: 0.1,
      minSolutions: 1,
      nodeCount: 120,
      edgeCount: 240,
      curveConstant: 21000,
    },
    {
      topologyHash: "0xtopo-alt",
      isDefault: false,
      difficultyEnergy: -14200,
      minDiversity: 0.15,
      minSolutions: 2,
      nodeCount: 64,
      edgeCount: 128,
      curveConstant: 19000,
    },
  ];
}

function buildObservability(nowIso: string): IndexerObservability {
  return {
    chainHeadFromNode: "1042",
    lastStatusFetchAt: nowIso,
    lastBlockInsertAt: nowIso,
    lastSubstrateEventAt: nowIso,
    bestBlockHeight: "1042",
    finalizedBlockHeight: "1039",
    chainConnected: true,
    selfIdentified: true,
    minerStats: {
      headsObserved: 4231,
      contextsDispatched: 8120,
      resultsReceived: 8044,
      proofsSubmitted: 312,
      staleDrops: 12,
      submissionErrors: 1,
      duplicateResultDrops: 3,
    },
    modes: {},
  };
}

export function sampleTelemetry(): Partial<TelemetryState> {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const nowIso = new Date(nowMs).toISOString();
  const blocks = buildBlocks(nowSec);
  return {
    blocks,
    selfAddress: SELF.account,
    indexer: buildObservability(nowIso),
    serverTime: nowIso,
    chainHead: {
      bestBlockNumber: "1042",
      bestBlockHash: "0xbest",
      finalizedBlockNumber: "1039",
      finalizedBlockHash: "0xfinal",
      finalityLag: 3,
      qblockCount: 1042,
      currentQBlockId: "1043",
      currentQBlockParticipants: 4,
      runtime: {
        specName: "quip",
        specVersion: 101,
        transactionVersion: 1,
        implName: "quip-node",
        lastRuntimeUpgrade: null,
      },
      updatedAt: nowIso,
    },
    babeEpoch: {
      epochIndex: 184,
      currentSlot: "442800",
      epochStartSlot: "442400",
      slotsPerEpoch: 600,
      currentSlotInEpoch: 400,
      authorityCount: 2,
    },
    babeAuthorities: buildBabeAuthorities(),
    chainMiners: buildChainMiners(blocks),
    recentDifficulty: buildDifficulty(),
    mineableTopologies: buildMineableTopologies(),
    validators: buildValidators(nowSec),
    nodes: buildNodes(nowSec),
    nodeDescriptors: buildNodeDescriptors(nowSec),
    recentMiningSubmissions: buildRecentSubmissions(nowSec),
    selfProblemsAttempted: 1042,
    currentDispatch: buildCurrentDispatch(),
    loading: false,
    error: null,
  };
}
