// SPDX-License-Identifier: AGPL-3.0-or-later

import { EventBus, type IEventBus } from "@vaaas/rx-react/event-bus";
import type { StoreApi } from "zustand";

import type { TelemetryState } from "../store/telemetry-store";
import type { UIState } from "../store/ui-store";
import { FetchTelemetry, fetchTelemetryHandler } from "./fetch-telemetry";
import {
  SetAggregationMode,
  setAggregationModeHandler,
  SetViewMode,
  setViewModeHandler,
  ToggleMinerType,
  toggleMinerTypeHandler,
} from "./ui-actions";

export interface AppEventBusDeps {
  telemetryStore: StoreApi<TelemetryState>;
  uiStore: StoreApi<UIState>;
}

export function buildAppEventBus(deps: AppEventBusDeps): IEventBus {
  return new EventBus()
    .on(FetchTelemetry, fetchTelemetryHandler({ telemetryStore: deps.telemetryStore }))
    .on(SetViewMode, setViewModeHandler({ uiStore: deps.uiStore }))
    .on(SetAggregationMode, setAggregationModeHandler({ uiStore: deps.uiStore }))
    .on(ToggleMinerType, toggleMinerTypeHandler({ uiStore: deps.uiStore }));
}
