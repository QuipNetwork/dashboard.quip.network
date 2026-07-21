import type { Story } from "@ladle/react";

import { StoryServices } from "@/testing/services";
import { sampleTelemetry } from "@/testing/sample-telemetry";
import { TimeToSolutionCard } from "./TimeToSolutionCard";

// TimeToSolutionCard reads blocks/chainMiners/nodeDescriptors off the
// Zustand telemetry store (via useTelemetryStore) rather than taking props,
// so stories seed the store through StoryServices — same mechanism
// Dashboard.stories.tsx and SyncIndicator.stories.tsx use to drive a
// store-reading component from a Ladle story.
export const Default: Story = () => (
  <StoryServices telemetry={sampleTelemetry()}>
    <TimeToSolutionCard />
  </StoryServices>
);

export const Empty: Story = () => (
  <StoryServices telemetry={{ blocks: [], chainMiners: [], nodeDescriptors: [] }}>
    <TimeToSolutionCard />
  </StoryServices>
);
