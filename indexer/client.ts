// SPDX-License-Identifier: AGPL-3.0-or-later

import { MiningSubmissionNotFoundError, parseMiningAttemptsApiResponse } from "../api/miner-api";
import type {
  MinerCategory,
  MinerStats,
  MiningAttemptsResponse,
  ModeBreakdown,
} from "../src/types/telemetry";

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
  // Per-backend breakdown from the in-container aggregator. Empty
  // record `{}` for legacy single-process miners; one entry per
  // active backend group (`cpu` / `gpu` / `qpu`) in multi-process
  // containers. Lets the UI show "qpu produced 0 proofs while cpu
  // produced 5" instead of just the aggregate.
  //
  // Optional so existing test fixtures and Partial<NodeStatus>
  // helpers don't have to thread an empty record through every
  // construction site. Consumers default to `{}` when reading.
  modes?: Record<string, ModeBreakdown>;
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
  fetchImpl?: FetchLike;
}

export class QuipClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: QuipClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
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
      modes: parseModes(data["modes"]),
    };
  }

  /**
   * Fetch the submission + iteration trail for a specific solution_id.
   * Throws {@link MiningSubmissionNotFoundError} on 404 (miner hasn't
   * observed this solution_id yet, or it was never assigned). Returns
   * with `observedAt=""` on `submission` — caller stamps the timestamp.
   */
  async getMiningAttempts(solutionId: number): Promise<MiningAttemptsResponse> {
    const url = `${this.baseUrl}/api/v1/mining/attempts?solution_id=${solutionId}`;
    const res = await this.fetchImpl(url, { headers: { accept: "application/json" } });
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
      headsObserved: Number(controller["heads_observed"] ?? 0),
      contextsDispatched: Number(controller["contexts_dispatched"] ?? 0),
      resultsReceived: Number(controller["results_received"] ?? 0),
      proofsSubmitted: Number(controller["proofs_submitted"] ?? 0),
      staleDrops: Number(controller["stale_drops"] ?? 0),
      submissionErrors: Number(controller["submission_errors"] ?? 0),
      duplicateResultDrops: Number(controller["duplicate_result_drops"] ?? 0),
    };
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { accept: "application/json" },
    });
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

/**
 * Parse the `modes` field returned by /api/v1/status. Tolerates the
 * legacy shape where the miner doesn't emit `modes` (returns `{}`) and
 * the new aggregator shape `{<mode>: {controller: {...}, miners: [...]}}`.
 *
 * Missing / malformed counters default to 0 — the UI shows "no work
 * yet" rather than crashing on a fresh aggregator that hasn't accrued
 * data.
 */
function parseModes(raw: unknown): Record<string, ModeBreakdown> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ModeBreakdown> = {};
  for (const [mode, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const ctrl = (v["controller"] as Record<string, unknown>) ?? {};
    const minersRaw = Array.isArray(v["miners"])
      ? (v["miners"] as Array<Record<string, unknown>>)
      : [];
    out[mode] = {
      headsObserved: Number(ctrl["heads_observed"] ?? 0),
      contextsDispatched: Number(ctrl["contexts_dispatched"] ?? 0),
      resultsReceived: Number(ctrl["results_received"] ?? 0),
      proofsSubmitted: Number(ctrl["proofs_submitted"] ?? 0),
      staleDrops: Number(ctrl["stale_drops"] ?? 0),
      submissionErrors: Number(ctrl["submission_errors"] ?? 0),
      duplicateResultDrops: Number(ctrl["duplicate_result_drops"] ?? 0),
      miners: minersRaw.map((m) => ({
        id: String(m["id"] ?? ""),
        type: narrowMinerType(m["type"]),
      })),
    };
  }
  return out;
}
