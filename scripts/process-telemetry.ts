import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { BlockRecord, MinerCategory, MinerConfig, NodesSnapshot } from "../src/types/telemetry";

const TELEMETRY_DIR = join(import.meta.dir, "../telemetry");
const OUTPUT_FILE = join(import.meta.dir, "../src/data/stub-telemetry.ts");

function classifyMiner(minerTypeJson: string): { category: MinerCategory; config: MinerConfig } {
  const config: MinerConfig = JSON.parse(minerTypeJson);
  let category: MinerCategory = "CPU";
  if (config.qpu) category = "QPU";
  else if (config.gpu) category = "GPU";
  return { category, config };
}

function getUnitCount(category: MinerCategory, config: MinerConfig): number {
  if (category === "GPU" && config.gpu) return config.gpu.devices.length;
  if (category === "CPU" && config.cpu) return config.cpu.num_cpus;
  return 1;
}

// Read all block files
const blocks: BlockRecord[] = [];
const entries = readdirSync(TELEMETRY_DIR, { withFileTypes: true });

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const epochDir = join(TELEMETRY_DIR, entry.name);
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
const nodesRaw = JSON.parse(readFileSync(join(TELEMETRY_DIR, "nodes.json"), "utf-8"));
const nodesSnapshot: NodesSnapshot = {
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

// Compute unique miners per category
const minersByCategory: Record<MinerCategory, Set<string>> = { CPU: new Set(), GPU: new Set(), QPU: new Set() };
for (const block of blocks) {
  minersByCategory[block.minerCategory].add(block.minerId);
}

// Compute total compute per category
const computeByCategory: Record<MinerCategory, number> = { CPU: 0, GPU: 0, QPU: 0 };
for (const block of blocks) {
  const units = getUnitCount(block.minerCategory, block.minerConfig);
  computeByCategory[block.minerCategory] += block.miningTime * units;
}

// Write output
const output = `// Auto-generated from telemetry data. Do not edit manually.
import type { BlockRecord, NodesSnapshot } from "../types/telemetry";

export const defaultBlocks: BlockRecord[] = ${JSON.stringify(blocks, null, 2)};

export const defaultNodes: NodesSnapshot = ${JSON.stringify(nodesSnapshot, null, 2)};

export const minerCountByCategory = ${JSON.stringify(
  Object.fromEntries(Object.entries(minersByCategory).map(([k, v]) => [k, v.size])),
)} as const;

export const totalComputeByCategory = ${JSON.stringify(computeByCategory)} as const;
`;

writeFileSync(OUTPUT_FILE, output);
console.log(`Wrote ${blocks.length} blocks to ${OUTPUT_FILE}`);
console.log(`Miners: CPU=${minersByCategory.CPU.size}, GPU=${minersByCategory.GPU.size}, QPU=${minersByCategory.QPU.size}`);
console.log(`Compute: CPU=${computeByCategory.CPU.toFixed(1)}s, GPU=${computeByCategory.GPU.toFixed(1)}s, QPU=${computeByCategory.QPU.toFixed(1)}s`);
