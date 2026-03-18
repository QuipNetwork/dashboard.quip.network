import { readdirSync, readFileSync } from "fs";
import { join } from "path";

type MinerCategory = "CPU" | "GPU" | "QPU";

interface MinerConfig {
  cpu: { num_cpus: number } | null;
  gpu: { backend: string; devices: string[] } | null;
  qpu: Record<string, unknown> | null;
}

interface BlockRecord {
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

interface NodeInfo {
  address: string;
  minerId: string | null;
  status: string;
  lastHeartbeat: number | null;
  firstSeen: number;
  lastSeen: number;
}

interface NodesSnapshot {
  updatedAt: string;
  nodeCount: number;
  activeCount: number;
  nodes: Record<string, NodeInfo>;
}

function classifyMiner(minerTypeJson: string): { category: MinerCategory; config: MinerConfig } {
  const config: MinerConfig = JSON.parse(minerTypeJson);
  let category: MinerCategory = "CPU";
  if (config.qpu) category = "QPU";
  else if (config.gpu) category = "GPU";
  return { category, config };
}

function loadTelemetry(): { blocks: BlockRecord[]; nodes: NodesSnapshot } {
  const telemetryDir = join(process.cwd(), "telemetry");

  // Read all block files
  const blocks: BlockRecord[] = [];
  const entries = readdirSync(telemetryDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const epochDir = join(telemetryDir, entry.name);
    const files = readdirSync(epochDir).filter((f) => f.endsWith(".json"));

    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(epochDir, file), "utf-8"));
      const { category, config } = classifyMiner(raw.miner.miner_type);

      blocks.push({
        blockIndex: raw.block_index,
        blockHash: raw.block_hash,
        timestamp: raw.timestamp,
        previousHash: raw.previous_hash,
        minerId: raw.miner.miner_id,
        minerCategory: category,
        minerConfig: config,
        energy: raw.quantum_proof.energy,
        diversity: raw.quantum_proof.diversity,
        numValidSolutions: raw.quantum_proof.num_valid_solutions,
        miningTime: raw.quantum_proof.mining_time,
        nonce: raw.quantum_proof.nonce,
        numNodes: raw.quantum_proof.num_nodes,
        numEdges: raw.quantum_proof.num_edges,
        difficultyEnergy: raw.requirements.difficulty_energy,
        minDiversity: raw.requirements.min_diversity,
        minSolutions: raw.requirements.min_solutions,
      });
    }
  }

  blocks.sort((a, b) => a.timestamp - b.timestamp || a.blockIndex - b.blockIndex);

  // Read nodes
  const nodesRaw = JSON.parse(readFileSync(join(telemetryDir, "nodes.json"), "utf-8"));
  const nodes: NodesSnapshot = {
    updatedAt: nodesRaw.updated_at,
    nodeCount: nodesRaw.node_count,
    activeCount: nodesRaw.active_count,
    nodes: Object.fromEntries(
      Object.entries(nodesRaw.nodes).map(([key, val]: [string, any]) => [
        key,
        {
          address: val.address,
          minerId: val.miner_id,
          status: val.status,
          lastHeartbeat: val.last_heartbeat,
          firstSeen: val.first_seen,
          lastSeen: val.last_seen,
        },
      ]),
    ),
  };

  return { blocks, nodes };
}

export default async () => {
  const data = loadTelemetry();

  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=1800",
    },
  });
};
