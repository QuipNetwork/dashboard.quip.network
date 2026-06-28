// SPDX-License-Identifier: AGPL-3.0-or-later

import { EventBusContext, type IEventBus } from "@vaaas/rx-react/event-bus";
import { useLayoutEffect, useMemo, type ReactNode } from "react";
import type { StoreApi } from "zustand";

import { buildAppEventBus } from "@/event-bus/build-app-event-bus";
import { TelemetryClientContext, telemetryClient, type TelemetryClient } from "./telemetry-client";
import {
  TelemetryStoreContext,
  telemetryStore,
  type TelemetryState,
} from "@/store/telemetry-store";
import { UIStoreContext, uiStore } from "@/store/ui-store";

type UIStore = typeof uiStore;

export interface ServicesProviderProps {
  children: ReactNode;
  telemetryStore?: StoreApi<TelemetryState>;
  uiStore?: UIStore;
  eventBus?: IEventBus;
  client?: TelemetryClient;
}

export function ServicesProvider({
  children,
  telemetryStore: telemetry = telemetryStore,
  uiStore: ui = uiStore,
  eventBus,
  client = telemetryClient,
}: ServicesProviderProps) {
  const bus = useMemo(
    () => eventBus ?? buildAppEventBus({ telemetryStore: telemetry, uiStore: ui }),
    [eventBus, telemetry, ui],
  );

  useLayoutEffect(() => {
    bus.start();
    return () => {
      bus.stop();
    };
  }, [bus]);

  return (
    <TelemetryClientContext.Provider value={client}>
      <TelemetryStoreContext.Provider value={telemetry}>
        <UIStoreContext.Provider value={ui}>
          <EventBusContext.Provider value={bus}>{children}</EventBusContext.Provider>
        </UIStoreContext.Provider>
      </TelemetryStoreContext.Provider>
    </TelemetryClientContext.Provider>
  );
}
