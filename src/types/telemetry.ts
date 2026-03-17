export type MinerCategory = "CPU" | "GPU" | "QPU";

export interface MinerConfig {
  cpu: { num_cpus: number } | null;
  gpu: { backend: string; devices: string[] } | null;
  qpu: Record<string, unknown> | null;
}

export interface BlockRecord {
  blockIndex: number;
  blockHash: string;
  timestamp: number;
  previousHash: string;
  minerId: string;
  minerCategory: MinerCategory;
  minerConfig: MinerConfig;
  energy: number;
  diversity: number;
  numValidSolutions: number;
  miningTime: number;
  nonce: number;
  numNodes: number;
  numEdges: number;
  difficultyEnergy: number;
  minDiversity: number;
  minSolutions: number;
}

export interface NodeInfo {
  address: string;
  minerId: string | null;
  status: string;
  lastHeartbeat: number | null;
  firstSeen: number;
  lastSeen: number;
}

export interface NodesSnapshot {
  updatedAt: string;
  nodeCount: number;
  activeCount: number;
  nodes: Record<string, NodeInfo>;
}
