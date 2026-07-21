import type { Story } from "@ladle/react";
import { Leaderboard } from "./Leaderboard";
import type { LeaderboardEntry } from "./use-leaderboard";

const sampleData: LeaderboardEntry[] = [
  {
    rank: 1,
    minerId: "gpu-1.carback",
    minerCategory: "GPU",
    blockCount: 142,
    share: 0.41,
    avgMiningTime: 3.2,
    bestEnergy: -15200.5,
  },
  {
    rank: 2,
    minerId: "cpu-1.carback",
    minerCategory: "CPU",
    blockCount: 98,
    share: 0.284,
    avgMiningTime: 222.0,
    bestEnergy: -14915.0,
  },
  {
    rank: 3,
    minerId: "gpu-2.carback",
    minerCategory: "GPU",
    blockCount: 64,
    share: 0.185,
    avgMiningTime: 4.7,
    bestEnergy: -15050.3,
  },
  {
    rank: 4,
    minerId: "qpu-1.carback",
    minerCategory: "QPU",
    blockCount: 32,
    share: 0.093,
    avgMiningTime: 1.1,
    bestEnergy: -15400.0,
  },
  {
    rank: 5,
    minerId: "cpu-2.carback",
    minerCategory: "CPU",
    blockCount: 10,
    share: 0.029,
    avgMiningTime: 310.5,
    bestEnergy: -14200.8,
  },
];

export const Default: Story = () => (
  <div className="h-96">
    <Leaderboard data={sampleData} />
  </div>
);

export const Empty: Story = () => (
  <div className="h-96">
    <Leaderboard data={[]} />
  </div>
);
