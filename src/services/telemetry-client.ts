// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MiningAttemptsResponse, TelemetryResponse } from "../types/telemetry";

export interface TelemetryClient {
  fetchTelemetry(signal?: AbortSignal): Promise<TelemetryResponse>;
  fetchMiningAttempts(solutionNumber: number, signal?: AbortSignal): Promise<MiningAttemptsResponse>;
}

export interface HttpTelemetryClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
}

export class HttpTelemetryClient implements TelemetryClient {
  private readonly fetch: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: HttpTelemetryClientOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl ?? "";
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
