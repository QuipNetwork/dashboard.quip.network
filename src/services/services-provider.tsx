// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import type { StoreApi } from "zustand";

import {
  TelemetryStoreContext,
  telemetryStore,
  type TelemetryState,
} from "../store/telemetry-store";
import { UIStoreContext, uiStore } from "../store/ui-store";

type UIStore = typeof uiStore;

export interface ServicesProviderProps {
  children: ReactNode;
  telemetryStore?: StoreApi<TelemetryState>;
  uiStore?: UIStore;
}

export function ServicesProvider({
  children,
  telemetryStore: telemetry = telemetryStore,
  uiStore: ui = uiStore,
}: ServicesProviderProps) {
  return (
    <TelemetryStoreContext.Provider value={telemetry}>
      <UIStoreContext.Provider value={ui}>{children}</UIStoreContext.Provider>
    </TelemetryStoreContext.Provider>
  );
}
