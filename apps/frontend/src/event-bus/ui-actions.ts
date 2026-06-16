// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Handler } from "@vaaas/rx-react/event-bus";
import { map, pipe } from "rxjs";
import type { StoreApi } from "zustand";

import type { AggregationMode, UIState, ViewMode } from "@/store/ui-store";
import type { MinerCategory } from "@quip/shared/telemetry";

export class SetViewMode {
  constructor(readonly mode: ViewMode) {}
}

export class SetAggregationMode {
  constructor(readonly mode: AggregationMode) {}
}

export class ToggleMinerType {
  constructor(readonly minerType: MinerCategory) {}
}

export interface UIActionDeps {
  uiStore: StoreApi<UIState>;
}

export const setViewModeHandler = (deps: UIActionDeps): Handler<typeof SetViewMode> =>
  pipe(map(({ event }) => deps.uiStore.getState().setViewMode(event.mode)));

export const setAggregationModeHandler = (deps: UIActionDeps): Handler<typeof SetAggregationMode> =>
  pipe(map(({ event }) => deps.uiStore.getState().setAggregationMode(event.mode)));

export const toggleMinerTypeHandler = (deps: UIActionDeps): Handler<typeof ToggleMinerType> =>
  pipe(map(({ event }) => deps.uiStore.getState().toggleMinerType(event.minerType)));
