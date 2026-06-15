// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, useContext } from "react";

import type { MiningAttemptsResponse, TelemetryResponse } from "../types/telemetry";

export interface TelemetryClient {
  fetchTelemetry(signal?: AbortSignal): Promise<TelemetryResponse>;
  fetchMiningAttempts(
    solutionNumber: number,
    signal?: AbortSignal,
  ): Promise<MiningAttemptsResponse>;
}

export interface HttpTelemetryClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
}

export class HttpTelemetryClient implements TelemetryClient {
  private readonly fetchImpl?: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: HttpTelemetryClientOptions = {}) {
    this.fetchImpl = options.fetch;
    this.baseUrl = options.baseUrl ?? "";
  }

  private fetch(input: string, init?: RequestInit): Promise<Response> {
    const f = this.fetchImpl ?? globalThis.fetch.bind(globalThis);
    return init ? f(input, init) : f(input);
  }

  async fetchTelemetry(signal?: AbortSignal): Promise<TelemetryResponse> {
    const res = await this.fetch(`${this.baseUrl}/api/telemetry`, signal ? { signal } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as TelemetryResponse;
  }

  async fetchMiningAttempts(
    solutionNumber: number,
    signal?: AbortSignal,
  ): Promise<MiningAttemptsResponse> {
    const res = await this.fetch(
      `${this.baseUrl}/api/mining/attempts/${solutionNumber}`,
      signal ? { signal } : undefined,
    );
    if (res.status === 404) throw new Error(`solution #${solutionNumber} not found on miner`);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as MiningAttemptsResponse;
  }
}

export const telemetryClient = new HttpTelemetryClient();

export const TelemetryClientContext = createContext<TelemetryClient>(telemetryClient);

export const useTelemetryClient = (): TelemetryClient => useContext(TelemetryClientContext);
