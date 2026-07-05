import type { Story } from "@ladle/react";

import { StoryServices } from "@/testing/services";
import { sampleTelemetry } from "@/testing/sample-telemetry";
import { EnergyDistributionCard } from "./EnergyDistributionCard";

// EnergyDistributionCard reads blocks/chainMiners off the Zustand telemetry
// store rather than taking props, so stories seed the store through
// StoryServices — same mechanism Dashboard.stories.tsx uses.
export const Default: Story = () => (
  <StoryServices telemetry={sampleTelemetry()}>
    <EnergyDistributionCard />
  </StoryServices>
);

// No blocks at all — all three per-type panels fall into the "No wins yet"
// empty state (see EnergyDistributionCard.test.tsx).
export const Empty: Story = () => (
  <StoryServices telemetry={{ blocks: [], chainMiners: [], nodeDescriptors: [] }}>
    <EnergyDistributionCard />
  </StoryServices>
);
