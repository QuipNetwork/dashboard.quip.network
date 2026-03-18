import type { Story } from "@ladle/react";
import { BlocksOverTimeChart } from "./BlocksOverTimeChart";
import type { BlocksOverTimeSeries } from "../../hooks/use-blocks-over-time";

const sampleData: BlocksOverTimeSeries[] = [
  {
    id: "CPU",
    data: [
      { x: 0, y: 1 },
      { x: 5, y: 3 },
      { x: 10, y: 7 },
      { x: 15, y: 12 },
    ],
  },
  {
    id: "GPU",
    data: [
      { x: 0, y: 2 },
      { x: 5, y: 6 },
      { x: 10, y: 11 },
      { x: 15, y: 18 },
    ],
  },
  {
    id: "QPU",
    data: [
      { x: 0, y: 3 },
      { x: 5, y: 10 },
      { x: 10, y: 19 },
      { x: 15, y: 30 },
    ],
  },
];

export const Default: Story = () => (
  <div className="h-96">
    <BlocksOverTimeChart data={sampleData} />
  </div>
);

export const Empty: Story = () => (
  <div className="h-96">
    <BlocksOverTimeChart data={[]} />
  </div>
);
