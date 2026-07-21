import type { Story } from "@ladle/react";

import { StoryServices } from "@/testing/services";
import { sampleTelemetry } from "@/testing/sample-telemetry";
import { LeaderboardCard } from "./LeaderboardCard";

// LeaderboardCard reads blocks/chainMiners/nodeDescriptors/nodes off the
// Zustand telemetry store rather than taking props, so stories seed the
// store through StoryServices — same mechanism Dashboard.stories.tsx uses.
// (Leaderboard.stories.tsx already covers the presentational <Leaderboard>
// table with hand-built rows; this file covers the store-reading Card.)
export const Default: Story = () => (
  <StoryServices telemetry={sampleTelemetry()}>
    <LeaderboardCard />
  </StoryServices>
);

export const Empty: Story = () => (
  <StoryServices telemetry={{ blocks: [], chainMiners: [], nodeDescriptors: [] }}>
    <LeaderboardCard />
  </StoryServices>
);
