// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Handler } from "@vaaas/rx-react/event-bus";
import { from, mergeMap, pipe } from "rxjs";
import type { StoreApi } from "zustand";

import type { TelemetryState } from "../store/telemetry-store";

export class FetchTelemetry {}

export interface FetchTelemetryDeps {
  telemetryStore: StoreApi<TelemetryState>;
}

export const fetchTelemetryHandler = (deps: FetchTelemetryDeps): Handler<typeof FetchTelemetry> =>
  pipe(mergeMap(() => from(deps.telemetryStore.getState().fetchTelemetry())));
