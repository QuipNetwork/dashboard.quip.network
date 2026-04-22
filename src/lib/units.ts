import type { NodesSnapshot } from "../types/telemetry";

// Under the v0.1 telemetry API, per-miner hardware unit count lives on the
// nodes snapshot, not the block. Build a miner_id → unit count lookup once
// per snapshot, then pass it to getUnitCount for each block.
//
// Unit semantics:
//   - CPU miners expose numCpus on a single entry → that many units
//   - GPU miners appear as one entry *per device* (keyed by deviceIndex)
//     so each entry is 1 unit; multi-GPU nodes show up as N entries
//   - QPU miners are 1 unit per entry
export function buildUnitCountIndex(nodes: NodesSnapshot | null): Map<string, number> {
  const idx = new Map<string, number>();
  if (!nodes) return idx;
  for (const node of Object.values(nodes.nodes)) {
    for (const miner of Object.values(node.miners ?? {})) {
      if (miner.kind === "CPU" && typeof miner.numCpus === "number") {
        idx.set(miner.minerId, miner.numCpus);
      } else {
        idx.set(miner.minerId, 1);
      }
    }
  }
  return idx;
}

export function getUnitCount(block: { minerId: string }, index: Map<string, number>): number {
  return index.get(block.minerId) ?? 1;
}
