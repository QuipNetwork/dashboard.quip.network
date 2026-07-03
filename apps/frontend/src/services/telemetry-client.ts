// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, useContext } from "react";

import type {
  BlockRecord,
  DifficultyHistoryResponse,
  MinerWinsResponse,
  MiningAttemptsResponse,
  NodeLiveData,
  TelemetryResponse,
} from "@quip/shared/telemetry";

export interface TelemetryClient {
  fetchTelemetry(signal?: AbortSignal): Promise<TelemetryResponse>;
  fetchMiningAttempts(
    solutionNumber: number,
    signal?: AbortSignal,
  ): Promise<MiningAttemptsResponse>;
  fetchBlocks(limit: number, offset: number, signal?: AbortSignal): Promise<BlockRecord[]>;
  // On-demand live snapshot for a peer node. `problem` is the current global
  // solution number (for the in-flight dispatch probe), or null to skip it.
  fetchNodeLive(
    accountId: string,
    problem: number | null,
    signal?: AbortSignal,
  ): Promise<NodeLiveData>;
  // Range-windowed difficulty history: rows at/after `sinceIso` plus the
  // anchor row before it (spec §10.5). Feeds the price-panel range selector.
  fetchDifficultyHistory(
    sinceIso: string,
    signal?: AbortSignal,
  ): Promise<DifficultyHistoryResponse>;
  // All-time per-miner win aggregates from the indexed blocks table — the
  // shared dataset behind every "qblocks won" surface (see MinerWinsRow).
  fetchMinerWins(signal?: AbortSignal): Promise<MinerWinsResponse>;
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

  async fetchBlocks(limit: number, offset: number, signal?: AbortSignal): Promise<BlockRecord[]> {
    const res = await this.fetch(
      `${this.baseUrl}/api/blocks?limit=${limit}&offset=${offset}`,
      signal ? { signal } : undefined,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { blocks: BlockRecord[] };
    return body.blocks;
  }

  async fetchDifficultyHistory(
    sinceIso: string,
    signal?: AbortSignal,
  ): Promise<DifficultyHistoryResponse> {
    const res = await this.fetch(
      `${this.baseUrl}/api/difficulty-history?since=${encodeURIComponent(sinceIso)}`,
      signal ? { signal } : undefined,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as DifficultyHistoryResponse;
  }

  async fetchMinerWins(signal?: AbortSignal): Promise<MinerWinsResponse> {
    const res = await this.fetch(`${this.baseUrl}/api/miner-wins`, signal ? { signal } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as MinerWinsResponse;
  }

  async fetchNodeLive(
    accountId: string,
    problem: number | null,
    signal?: AbortSignal,
  ): Promise<NodeLiveData> {
    const query = problem != null ? `?problem=${problem}` : "";
    const res = await this.fetch(
      `${this.baseUrl}/api/node/${encodeURIComponent(accountId)}/live${query}`,
      signal ? { signal } : undefined,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as NodeLiveData;
  }
}

export const telemetryClient = new HttpTelemetryClient();

export const TelemetryClientContext = createContext<TelemetryClient>(telemetryClient);

export const useTelemetryClient = (): TelemetryClient => useContext(TelemetryClientContext);
