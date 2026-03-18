import type { Story } from "@ladle/react";
import { ActiveNodesChart } from "./ActiveNodesChart";
import type { ActiveNodesEntry } from "./use-active-nodes";

const sampleData: ActiveNodesEntry[] = [
  { minerType: "CPU", count: 42 },
  { minerType: "GPU", count: 18 },
  { minerType: "QPU", count: 3 },
];

export const Default: Story = () => (
  <div className="h-96">
    <ActiveNodesChart data={sampleData} />
  </div>
);

export const Empty: Story = () => (
  <div className="h-96">
    <ActiveNodesChart data={[]} />
  </div>
);
