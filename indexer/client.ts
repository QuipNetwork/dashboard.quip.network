// SPDX-License-Identifier: AGPL-3.0-or-later

export interface StatusBody {
  epochs: string[];
  latestEpoch: number;
  latestBlockIndex: number;
  totalBlocks: number;
  nodeCount: number;
  activeNodeCount: number;
  nodesUpdatedAt: string | null;
}

export interface EpochsBody {
  epochs: Array<{
    epoch: number;
    blockCount: number;
    firstBlock: number;
    lastBlock: number;
  }>;
}

export interface ClientResponse<T> {
  status: number;
  etag: string | null;
  body: T | null;
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
  timestamp?: string;
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

  async getStatus(etag: string | null): Promise<ClientResponse<StatusBody>> {
    const path = "/api/v1/telemetry/status";
    const res = await this.request(path, etag);
    if (res.status === 304) return { status: 304, etag, body: null };
    const raw = await this.readEnvelope<Record<string, unknown>>(res, path);
    const data = raw ?? {};
    const latestEpochStr = String(data["latest_epoch"] ?? "");
    const body: StatusBody = {
      epochs: Array.isArray(data["epochs"])
        ? (data["epochs"] as unknown[]).map((s) => String(s))
        : [],
      latestEpoch: latestEpochStr ? Number(latestEpochStr) : 0,
      latestBlockIndex: Number(data["latest_block_index"] ?? 0),
      totalBlocks: Number(data["total_blocks"] ?? 0),
      nodeCount: Number(data["node_count"] ?? 0),
      activeNodeCount: Number(data["active_node_count"] ?? 0),
      nodesUpdatedAt: (data["nodes_updated_at"] as string | null) ?? null,
    };
    return { status: res.status, etag: res.headers.get("etag"), body };
  }

  async getEpochs(): Promise<EpochsBody> {
    const path = "/api/v1/telemetry/epochs";
    const res = await this.request(path, null);
    const data = (await this.readEnvelope<Record<string, unknown>>(res, path)) ?? {};
    const rawEpochs = Array.isArray(data["epochs"])
      ? (data["epochs"] as Array<Record<string, unknown>>)
      : [];
    return {
      epochs: rawEpochs.map((e) => ({
        epoch: Number(e["epoch"] ?? 0),
        blockCount: Number(e["block_count"] ?? 0),
        firstBlock: Number(e["first_block"] ?? 0),
        lastBlock: Number(e["last_block"] ?? 0),
      })),
    };
  }

  /**
   * Fetch a single block. Returns null on 404. The `nonce` field is
   * preserved as a string because u64 values exceed Number.MAX_SAFE_INTEGER.
   */
  async getBlock(epoch: number, blockIndex: number): Promise<Record<string, unknown> | null> {
    const path = `/api/v1/telemetry/epochs/${epoch}/blocks/${blockIndex}`;
    const res = await this.request(path, null);
    if (res.status === 404) return null;
    if (!res.ok) {
      this.throwForStatus(res.status, path);
    }
    const text = await res.text();
    // Preserve nonce precision: quote the bare integer before JSON.parse.
    const safe = text.replace(/"nonce"\s*:\s*(\d+)/g, '"nonce":"$1"');
    const parsed = JSON.parse(safe) as ApiEnvelope<Record<string, unknown>>;
    if (parsed && typeof parsed === "object" && parsed.success === false) {
      throw new Error(`[indexer] ${path}: ${parsed.error ?? "envelope reported failure"}`);
    }
    const data =
      parsed && typeof parsed === "object" && "data" in parsed
        ? ((parsed.data ?? null) as Record<string, unknown> | null)
        : (parsed as unknown as Record<string, unknown>);
    if (data) assertNonceShape(data, path);
    return data;
  }

  async getNodes(etag: string | null): Promise<ClientResponse<Record<string, unknown>>> {
    const res = await this.request("/api/v1/telemetry/nodes", etag);
    if (res.status === 304) return { status: 304, etag, body: null };
    const body = await this.readEnvelope<Record<string, unknown>>(res, "/api/v1/telemetry/nodes");
    return { status: res.status, etag: res.headers.get("etag"), body };
  }

  private async request(path: string, etag: string | null): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.token) headers["authorization"] = `Bearer ${this.token}`;
    if (etag) headers["if-none-match"] = etag;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers });
    if (res.status === 401) {
      throw new AuthError(
        `[indexer] 401 Unauthorized from ${path}. Set QUIP_NODE_TOKEN (or --token) to a valid bearer token.`,
      );
    }
    if (res.status === 429) {
      throw new RateLimitError(`[indexer] 429 Too Many Requests from ${path}`);
    }
    return res;
  }

  private throwForStatus(status: number, path: string): never {
    throw new Error(`[indexer] ${status} from ${path}`);
  }

  private async readEnvelope<T>(res: Response, path: string): Promise<T | null> {
    if (res.status === 304) return null;
    if (!res.ok) {
      this.throwForStatus(res.status, path);
    }
    const parsed = (await res.json()) as ApiEnvelope<T>;
    if (parsed && typeof parsed === "object" && parsed.success === false) {
      throw new Error(`[indexer] ${path}: ${parsed.error ?? "envelope reported failure"}`);
    }
    if (parsed && typeof parsed === "object" && "data" in parsed) {
      return (parsed.data ?? null) as T | null;
    }
    return parsed as unknown as T;
  }
}

/**
 * Guard that the regex pre-pass actually produced a well-formed string nonce.
 * A failed substitution (e.g. nonce already quoted non-numerically, or a
 * decimal literal) would otherwise surface as a generic DB error at insert
 * time; fail loud at the boundary instead.
 */
function assertNonceShape(data: Record<string, unknown>, path: string): void {
  const qp = data["quantum_proof"];
  if (qp == null || typeof qp !== "object") return;
  const nonce = (qp as Record<string, unknown>)["nonce"];
  if (nonce === undefined) return;
  if (typeof nonce !== "string" || !/^\d+$/.test(nonce)) {
    throw new Error(
      `[indexer] ${path}: malformed nonce (expected digit string, got ${typeof nonce}: ${String(nonce).slice(0, 64)})`,
    );
  }
}
