// SPDX-License-Identifier: AGPL-3.0-or-later

import { EventBus, type IEventBus } from "@vaaas/rx-react/event-bus";
import type { StoreApi } from "zustand";

import type { TelemetryState } from "../store/telemetry-store";
import { FetchTelemetry, fetchTelemetryHandler } from "./fetch-telemetry";

export interface AppEventBusDeps {
  telemetryStore: StoreApi<TelemetryState>;
}

export function buildAppEventBus(deps: AppEventBusDeps): IEventBus {
  return new EventBus().on(
    FetchTelemetry,
    fetchTelemetryHandler({ telemetryStore: deps.telemetryStore }),
  );
}
