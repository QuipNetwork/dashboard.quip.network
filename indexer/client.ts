// SPDX-License-Identifier: AGPL-3.0-or-later

import { MiningSubmissionNotFoundError, parseMiningAttemptsApiResponse } from "../api/miner-api";
import type { MinerCategory, MinerStats, MiningAttemptsResponse } from "../src/types/telemetry";

export interface NodeStatus {
  ss58Address: string;
  accountIdHex: string;
  nodeId: string;
  isMining: boolean;
  uptimeSeconds: number;
  chainHeadHash: string;
  chainHeadNumber: number;
  minerRegistered: boolean;
  minerInfo: {
    registeredAt: number;
    deposit: string; // u128 as string
    proofsSubmitted: string; // u64 as string
    proofsWon: string;
    rewardsEarned: string; // u128 as string
  } | null;
  miners: Array<{ id: string; type: MinerCategory }>;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

interface ApiEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: string;
  timestamp?: number;
}

type FetchLike = typeof fetch;

export interface QuipClientOptions {
  baseUrl: string;
  token?: string | undefined;
  fetchImpl?: FetchLike;
}

export class QuipClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: FetchLike;

  constructor(opts: QuipClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getStatus(): Promise<NodeStatus> {
    const data = await this.getJson<Record<string, unknown>>("/api/v1/status");
    const chain = (data["chain"] as Record<string, unknown>) ?? {};
    const minerInfoRaw = data["miner_info"] as Record<string, unknown> | undefined;
    return {
      ss58Address: String(data["ss58_address"] ?? ""),
      accountIdHex: String(data["account_id_hex"] ?? ""),
      nodeId: String(data["node_id"] ?? ""),
      isMining: Boolean(data["is_mining"]),
      uptimeSeconds: Number(data["uptime_seconds"] ?? 0),
      chainHeadHash: String(chain["head_hash"] ?? ""),
      chainHeadNumber: Number(chain["head_number"] ?? 0),
      minerRegistered: Boolean(data["miner_registered"]),
      minerInfo: minerInfoRaw
        ? {
            registeredAt: Number(minerInfoRaw["registered_at"] ?? 0),
            deposit: String(minerInfoRaw["deposit"] ?? "0"),
            proofsSubmitted: String(minerInfoRaw["proofs_submitted"] ?? "0"),
            proofsWon: String(minerInfoRaw["proofs_won"] ?? "0"),
            rewardsEarned: String(minerInfoRaw["rewards_earned"] ?? "0"),
          }
        : null,
      miners: Array.isArray(data["miners"])
        ? (data["miners"] as Array<Record<string, unknown>>).map((m) => ({
            id: String(m["id"] ?? ""),
            type: narrowMinerType(m["type"]),
          }))
        : [],
    };
  }

  /**
   * Fetch the submission + iteration trail for a specific solution_id.
   * Throws {@link MiningSubmissionNotFoundError} on 404 (miner hasn't
   * observed this solution_id yet, or it was never assigned). Returns
   * with `observedAt=""` on `submission` — caller stamps the timestamp.
   */
  async getMiningAttempts(solutionId: number): Promise<MiningAttemptsResponse> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.token) headers["authorization"] = `Bearer ${this.token}`;
    const url = `${this.baseUrl}/api/v1/mining/attempts?solution_id=${solutionId}`;
    const res = await this.fetchImpl(url, { headers });
    if (res.status === 401) {
      throw new AuthError(`[indexer] 401 from /api/v1/mining/attempts. Set QUIP_NODE_TOKEN.`);
    }
    if (res.status === 404) {
      throw new MiningSubmissionNotFoundError(solutionId);
    }
    if (res.status === 429) {
      throw new RateLimitError(`[indexer] 429 from /api/v1/mining/attempts`);
    }
    if (!res.ok) {
      throw new Error(`[indexer] ${res.status} from /api/v1/mining/attempts`);
    }
    const parsed = (await res.json()) as { success?: boolean; data?: unknown; error?: string };
    if (parsed && typeof parsed === "object" && parsed.success === false) {
      throw new Error(
        `[indexer] /api/v1/mining/attempts: ${parsed.error ?? "envelope reported failure"}`,
      );
    }
    return parseMiningAttemptsApiResponse(parsed?.data ?? parsed);
  }

  async getStats(): Promise<MinerStats> {
    const data = await this.getJson<Record<string, unknown>>("/api/v1/stats");
    const controller = (data["controller"] as Record<string, unknown>) ?? {};
    return {
      totalBlocksAttempted: Number(data["total_blocks_attempted"] ?? 0),
      totalBlocksWon: Number(data["total_blocks_won"] ?? 0),
      winRate: Number(data["win_rate"] ?? 0),
      totalMiningTime: Number(data["total_mining_time"] ?? 0),
      avgMiningTime: Number(data["avg_mining_time"] ?? 0),
      headsObserved: Number(controller["heads_observed"] ?? 0),
      contextsDispatched: Number(controller["contexts_dispatched"] ?? 0),
      resultsReceived: Number(controller["results_received"] ?? 0),
      proofsSubmitted: Number(controller["proofs_submitted"] ?? 0),
      staleDrops: Number(controller["stale_drops"] ?? 0),
      submissionErrors: Number(controller["submission_errors"] ?? 0),
    };
  }

  private async getJson<T>(path: string): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.token) headers["authorization"] = `Bearer ${this.token}`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers });
    if (res.status === 401) {
      throw new AuthError(`[indexer] 401 from ${path}. Set QUIP_NODE_TOKEN.`);
    }
    if (res.status === 429) {
      throw new RateLimitError(`[indexer] 429 from ${path}`);
    }
    if (!res.ok) {
      throw new Error(`[indexer] ${res.status} from ${path}`);
    }
    const parsed = (await res.json()) as ApiEnvelope<T>;
    if (parsed && typeof parsed === "object" && parsed.success === false) {
      throw new Error(`[indexer] ${path}: ${parsed.error ?? "envelope reported failure"}`);
    }
    return (parsed?.data ?? parsed) as T;
  }
}

function narrowMinerType(raw: unknown): MinerCategory {
  const s = String(raw ?? "").toUpperCase();
  if (s === "CPU" || s === "GPU" || s === "QPU") return s;
  return "OTHER";
}
