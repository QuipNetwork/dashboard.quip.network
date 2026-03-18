import type { Story } from "@ladle/react";
import { ComputeUsedChart } from "./ComputeUsedChart";
import type { ComputeUsedEntry } from "../../hooks/use-compute-used";

const sampleData: ComputeUsedEntry[] = [
  { minerType: "CPU", compute: 4520 },
  { minerType: "GPU", compute: 1230 },
  { minerType: "QPU", compute: 340 },
];

export const Default: Story = () => (
  <div className="h-96">
    <ComputeUsedChart data={sampleData} />
  </div>
);

export const Empty: Story = () => (
  <div className="h-96">
    <ComputeUsedChart data={[]} />
  </div>
);
