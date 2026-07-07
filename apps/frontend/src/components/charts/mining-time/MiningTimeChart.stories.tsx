import type { Story } from "@ladle/react";
import { MiningTimeChart } from "./MiningTimeChart";
import type { MiningTimeSeries } from "./use-mining-time";

const sampleData: MiningTimeSeries[] = [
  {
    id: "CPU",
    data: [
      { x: 1, y: 12.3 },
      { x: 2, y: 10.1 },
      { x: 3, y: 14.5 },
    ],
  },
  {
    id: "GPU",
    data: [
      { x: 1, y: 3.2 },
      { x: 2, y: 2.8 },
      { x: 3, y: 4.1 },
    ],
  },
  {
    id: "QPU",
    data: [
      { x: 1, y: 1.1 },
      { x: 2, y: 0.9 },
      { x: 3, y: 1.4 },
    ],
  },
];

// Normalized-composition shares (0–100%) with the QPU split into its two
// participation regimes — labels carry the "%" suffix like win-rate's mode.
const normalizedData: MiningTimeSeries[] = [
  {
    id: "CPU",
    data: [
      { x: 1, y: 62.1 },
      { x: 2, y: 58.4 },
      { x: 3, y: 60.2 },
    ],
  },
  {
    id: "GPU",
    data: [
      { x: 1, y: 20.3 },
      { x: 2, y: 22.9 },
      { x: 3, y: 21.5 },
    ],
  },
  {
    id: "QPU20m",
    data: [
      { x: 1, y: 0.2 },
      { x: 2, y: 0.3 },
      { x: 3, y: 0.2 },
    ],
  },
  {
    id: "QPU100",
    label: "QPU100%",
    data: [
      { x: 1, y: 17.4 },
      { x: 2, y: 18.4 },
      { x: 3, y: 18.1 },
    ],
  },
];

export const Default: Story = () => (
  <div className="h-96">
    <MiningTimeChart data={sampleData} />
  </div>
);

export const Energy: Story = () => (
  <div className="h-96">
    <MiningTimeChart
      data={sampleData.map((s) => ({
        ...s,
        data: s.data.map((p) => ({ ...p, y: p.y * 400 })),
      }))}
      metric="energy"
    />
  </div>
);

export const Normalized: Story = () => (
  <div className="h-96">
    <MiningTimeChart data={normalizedData} normalized />
  </div>
);

export const Empty: Story = () => (
  <div className="h-96">
    <MiningTimeChart data={[]} />
  </div>
);
