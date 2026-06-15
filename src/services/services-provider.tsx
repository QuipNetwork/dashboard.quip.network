// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import type { StoreApi } from "zustand";

import { TelemetryStoreContext, telemetryStore, type TelemetryState } from "../store/telemetry-store";

export interface ServicesProviderProps {
  children: ReactNode;
  telemetryStore?: StoreApi<TelemetryState>;
}

export function ServicesProvider({
  children,
  telemetryStore: telemetry = telemetryStore,
}: ServicesProviderProps) {
  return <TelemetryStoreContext.Provider value={telemetry}>{children}</TelemetryStoreContext.Provider>;
}
