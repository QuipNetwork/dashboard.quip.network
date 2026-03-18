import type { MinerCategory, MinerConfig } from "../types/telemetry";

export function getUnitCount(block: {
  minerCategory: MinerCategory;
  minerConfig: Pick<MinerConfig, "cpu" | "gpu">;
}): number {
  if (block.minerCategory === "GPU" && block.minerConfig.gpu)
    return block.minerConfig.gpu.devices.length;
  if (block.minerCategory === "CPU" && block.minerConfig.cpu) return block.minerConfig.cpu.num_cpus;
  return 1;
}
