// SPDX-License-Identifier: AGPL-3.0-or-later

import type { IEventBus } from "@vaaas/rx-react/event-bus";
import { useMemo, type ReactNode } from "react";
import type { StoreApi } from "zustand";

import { buildAppEventBus } from "../event-bus/build-app-event-bus";
import { ServicesProvider } from "../services/services-provider";
import type { TelemetryClient } from "../services/telemetry-client";
import { createTelemetryStore, type TelemetryState } from "../store/telemetry-store";
import { createUIStore, type UIState } from "../store/ui-store";

const idleClient: TelemetryClient = {
  fetchTelemetry: () => new Promise<never>(() => {}),
  fetchMiningAttempts: () => new Promise<never>(() => {}),
};

export interface TestServicesOverrides {
  telemetry?: Partial<TelemetryState>;
  ui?: Partial<UIState>;
  client?: TelemetryClient;
}

export interface TestServices {
  telemetryStore: StoreApi<TelemetryState>;
  uiStore: StoreApi<UIState>;
  eventBus: IEventBus;
  client: TelemetryClient;
}

export function createTestServices(overrides: TestServicesOverrides = {}): TestServices {
  const client = overrides.client ?? idleClient;
  const telemetryStore = createTelemetryStore({ client });
  if (overrides.telemetry) telemetryStore.setState(overrides.telemetry);
  const uiStore = createUIStore();
  if (overrides.ui) uiStore.setState(overrides.ui);
  const eventBus = buildAppEventBus({ telemetryStore, uiStore });
  return { telemetryStore, uiStore, eventBus, client };
}

export function StoryServices({
  children,
  telemetry,
  ui,
  client,
}: TestServicesOverrides & { children: ReactNode }) {
  const services = useMemo(() => createTestServices({ telemetry, ui, client }), []);
  return <ServicesProvider {...services}>{children}</ServicesProvider>;
}
