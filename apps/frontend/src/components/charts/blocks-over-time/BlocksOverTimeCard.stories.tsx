import type { Story } from "@ladle/react";

import { StoryServices } from "@/testing/services";
import { sampleTelemetry } from "@/testing/sample-telemetry";
import { BlocksOverTimeCard } from "./BlocksOverTimeCard";

// BlocksOverTimeCard reads blocks/nodeDescriptors off the Zustand telemetry
// store and aggregationMode off the UI store, rather than taking props, so
// stories seed both stores through StoryServices — same mechanism
// Dashboard.stories.tsx uses.
export const Default: Story = () => (
  <StoryServices telemetry={sampleTelemetry()}>
    <BlocksOverTimeCard />
  </StoryServices>
);

// aggregationMode "byNode" hides the By Type | Normalized toggle — there's
// no per-type device count to divide by (see the card's own doc comment).
export const ByNode: Story = () => (
  <StoryServices telemetry={sampleTelemetry()} ui={{ aggregationMode: "byNode" }}>
    <BlocksOverTimeCard />
  </StoryServices>
);

export const Empty: Story = () => (
  <StoryServices telemetry={{ blocks: [], chainMiners: [], nodeDescriptors: [] }}>
    <BlocksOverTimeCard />
  </StoryServices>
);
