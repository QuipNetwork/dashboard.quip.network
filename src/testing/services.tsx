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
}

export interface TestServices {
  telemetryStore: StoreApi<TelemetryState>;
  uiStore: StoreApi<UIState>;
  eventBus: IEventBus;
}

export function createTestServices(overrides: TestServicesOverrides = {}): TestServices {
  const telemetryStore = createTelemetryStore({ client: idleClient });
  if (overrides.telemetry) telemetryStore.setState(overrides.telemetry);
  const uiStore = createUIStore();
  if (overrides.ui) uiStore.setState(overrides.ui);
  const eventBus = buildAppEventBus({ telemetryStore });
  return { telemetryStore, uiStore, eventBus };
}

export function StoryServices({
  children,
  telemetry,
  ui,
}: TestServicesOverrides & { children: ReactNode }) {
  const services = useMemo(() => createTestServices({ telemetry, ui }), []);
  return <ServicesProvider {...services}>{children}</ServicesProvider>;
}
