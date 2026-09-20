// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, useContext } from "react";

import type {
  BlockRecord,
  CurrentDispatch,
  DifficultyHistoryResponse,
  MinerWinsResponse,
  MiningAttemptsResponse,
  MiningHistoryResponse,
  NodeLiveData,
  NodeSummaryResponse,
  ParticipationComputeRow,
  QblockFile,
  TelemetryResponse,
} from "@quip/shared/telemetry";
import { participationFromQblockFiles } from "@quip/shared/telemetry";

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
  // One node's stored win summary and the winner block of its last won qblock.
  fetchNodeSummary(accountId: string, signal?: AbortSignal): Promise<NodeSummaryResponse>;
  // Range-windowed slim winner-block rows at/after `sinceIso`, ascending.
  // Feeds the "Mining per QBlock" range selector.
  fetchMiningHistory(sinceIso: string, signal?: AbortSignal): Promise<MiningHistoryResponse>;
  // Fetch the qblock manifest from `manifestUrl` and the recent qblock files
  // it lists. The data covers every qblock file loaded so far, recent and history.
  fetchQblocks(manifestUrl: string, signal?: AbortSignal): Promise<QblockSnapshot>;
  // Load one day of older qblocks named in `QblockSnapshot.history`. The data
  // covers every qblock file loaded so far.
  fetchQblockHistoryDay(dayPath: string, signal?: AbortSignal): Promise<QblockData>;
  // The local miner's current dispatch, or null when the file is missing.
  fetchMinerCurrentDispatch(url: string, signal?: AbortSignal): Promise<CurrentDispatch | null>;
}

// What the loaded qblock files hold, across every file loaded so far.
export interface QblockData {
  rows: ParticipationComputeRow[];
  // The winner block of each loaded qblock that has one, in no set order.
  winners: BlockRecord[];
}

export interface QblockSnapshot extends QblockData {
  // Day manifests (relative to /files, newest first) not yet loaded.
  history: string[];
}

interface QblockManifest {
  qblocks: string[];
  history?: string[];
}

// A qblock file settles once its participation pages land, seconds after the
// winner. Files whose winner is older than this are fetched once and cached.
const QBLOCK_SETTLED_SECONDS = 600;
// Browsers reject thousands of simultaneous requests
// (ERR_INSUFFICIENT_RESOURCES), so qblock files download through a small pool.
const QBLOCK_FETCH_CONCURRENCY = 8;

export interface HttpTelemetryClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
}

export class HttpTelemetryClient implements TelemetryClient {
  private readonly fetchImpl?: typeof fetch;
  private readonly baseUrl: string;
  // Latest copy of every qblock file loaded, by path under /files.
  private readonly qblockFiles = new Map<string, QblockFile>();
  // Paths whose file has settled and is never fetched again.
  private readonly settledQblocks = new Set<string>();
  // Day manifests already loaded.
  private readonly loadedHistoryDays = new Set<string>();

  constructor(options: HttpTelemetryClientOptions = {}) {
    this.fetchImpl = options.fetch;
    this.baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
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

  async fetchNodeSummary(accountId: string, signal?: AbortSignal): Promise<NodeSummaryResponse> {
    const res = await this.fetch(
      `${this.baseUrl}/api/node/${encodeURIComponent(accountId)}/summary`,
      signal ? { signal } : undefined,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as NodeSummaryResponse;
  }

  async fetchMiningHistory(sinceIso: string, signal?: AbortSignal): Promise<MiningHistoryResponse> {
    const res = await this.fetch(
      `${this.baseUrl}/api/mining-history?since=${encodeURIComponent(sinceIso)}`,
      signal ? { signal } : undefined,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as MiningHistoryResponse;
  }

  async fetchQblocks(manifestUrl: string, signal?: AbortSignal): Promise<QblockSnapshot> {
    const manifestRes = await this.fetch(manifestUrl, signal ? { signal } : undefined);
    if (!manifestRes.ok) throw new Error(`HTTP ${manifestRes.status}`);
    const manifest = (await manifestRes.json()) as QblockManifest;
    await this.loadQblockFiles(manifest.qblocks, signal);
    return {
      ...this.qblockData(),
      history: (manifest.history ?? []).filter((day) => !this.loadedHistoryDays.has(day)),
    };
  }

  async fetchQblockHistoryDay(dayPath: string, signal?: AbortSignal): Promise<QblockData> {
    const res = await this.fetch(
      `${this.baseUrl}/files/${dayPath}`,
      signal ? { signal } : undefined,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const day = (await res.json()) as QblockManifest;
    await this.loadQblockFiles(day.qblocks, signal);
    this.loadedHistoryDays.add(dayPath);
    return this.qblockData();
  }

  private qblockData(): QblockData {
    const files = [...this.qblockFiles.values()];
    return {
      rows: participationFromQblockFiles(files),
      winners: files.flatMap((file) => (file.winner ? [file.winner] : [])),
    };
  }

  // Fetch every listed file that has not settled, through a small pool.
  private async loadQblockFiles(paths: readonly string[], signal?: AbortSignal): Promise<void> {
    const pending = paths.filter((path) => !this.settledQblocks.has(path));
    const settledBefore = Date.now() / 1000 - QBLOCK_SETTLED_SECONDS;
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let path = pending[next++]; path !== undefined; path = pending[next++]) {
        const file = await this.fetchQblockFile(path, signal);
        if (file === null) continue;
        this.qblockFiles.set(path, file);
        if (file.winner !== null && file.winner.timestamp < settledBefore) {
          this.settledQblocks.add(path);
        }
      }
    };
    const workers = Math.min(QBLOCK_FETCH_CONCURRENCY, pending.length);
    await Promise.all(Array.from({ length: workers }, worker));
  }

  // One qblock file, or null when it is unavailable. A missing or failed file
  // is skipped rather than failing the batch; the next poll retries it.
  private async fetchQblockFile(path: string, signal?: AbortSignal): Promise<QblockFile | null> {
    try {
      const res = await this.fetch(
        `${this.baseUrl}/files/${path}`,
        signal ? { signal } : undefined,
      );
      if (!res.ok) return null;
      return (await res.json()) as QblockFile;
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
  }

  // The local miner's current dispatch, or null when the file is missing.
  // A missing file means the poller has not written one yet; the caller
  // degrades to "no dispatch" rather than failing the whole poll.
  async fetchMinerCurrentDispatch(
    url: string,
    signal?: AbortSignal,
  ): Promise<CurrentDispatch | null> {
    try {
      const res = await this.fetch(`${this.baseUrl}${url}`, signal ? { signal } : undefined);
      if (!res.ok) return null;
      return (await res.json()) as CurrentDispatch;
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
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

export const telemetryClient = new HttpTelemetryClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL,
});

export const TelemetryClientContext = createContext<TelemetryClient>(telemetryClient);

export const useTelemetryClient = (): TelemetryClient => useContext(TelemetryClientContext);
