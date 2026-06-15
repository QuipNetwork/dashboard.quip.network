import type { Story } from "@ladle/react";

import { StoryServices } from "@/testing/services";
import { sampleTelemetry } from "@/testing/sample-telemetry";
import type { ViewMode } from "@/store/ui-store";
import { Dashboard } from "./Dashboard";

function PopulatedDashboard({ viewMode }: { viewMode: ViewMode }) {
  return (
    <StoryServices telemetry={sampleTelemetry()} ui={{ viewMode }}>
      <Dashboard />
    </StoryServices>
  );
}

export const MyNode: Story = () => <PopulatedDashboard viewMode="my-node" />;

export const Network: Story = () => <PopulatedDashboard viewMode="network" />;

export const Compute: Story = () => <PopulatedDashboard viewMode="compute" />;

export const Chain: Story = () => <PopulatedDashboard viewMode="chain" />;

export const Loading: Story = () => (
  <StoryServices telemetry={{ loading: true }}>
    <Dashboard />
  </StoryServices>
);

export const ErrorState: Story = () => (
  <StoryServices telemetry={{ loading: false, error: "indexer unreachable: HTTP 503" }}>
    <Dashboard />
  </StoryServices>
);
