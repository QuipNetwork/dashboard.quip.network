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

export const Default: Story = () => (
  <div className="h-96">
    <MiningTimeChart data={sampleData} />
  </div>
);

export const Empty: Story = () => (
  <div className="h-96">
    <MiningTimeChart data={[]} />
  </div>
);
