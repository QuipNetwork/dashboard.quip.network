import type { Story } from "@ladle/react";
import { ComputeUsedChart } from "./ComputeUsedChart";
import type { ComputeUsedEntry } from "./use-compute-used";

const sampleData: ComputeUsedEntry[] = [
  { minerType: "CPU", compute: 4520, displayCompute: 4520, floored: false, estimated: true },
  { minerType: "GPU", compute: 1230, displayCompute: 1230, floored: false, estimated: false },
  // Real QPU total is tiny next to CPU/GPU wall-clock — floored to a
  // visible minimum slice, as it would be live (see use-compute-used.ts).
  { minerType: "QPU", compute: 6.8, displayCompute: 135.6, floored: true, estimated: true },
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
