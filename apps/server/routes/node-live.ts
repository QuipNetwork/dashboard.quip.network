// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Hono } from "hono";

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import { parseDispatchAttemptsApiResponse } from "@quip/core/miner-api";
import {
  parseMinerStatsPayload,
  parseStatusModes,
  parseStatusPrimaryMinerId,
} from "@quip/core/miner-live";
import { resolvePeerMinerRestUrl } from "@quip/core/resolve-miner-rest";
import type {
  CurrentDispatch,
  MinerStats,
  MiningAttempt,
  ModeBreakdown,
  NodeLiveData,
} from "@quip/shared/telemetry";

interface NodeLiveOptions {
  // Only the descriptor lookup is needed — resolves the peer's REST host.
  db: Pick<DatabaseAdapter, "getNodeDescriptor">;
  // Injectable for tests; defaults to global fetch.
  fetchImpl?: typeof fetch;
  // Injectable clock for deterministic `fetchedAt` in tests.
  now?: () => Date;
}

// Peer probes are best-effort with a short ceiling — a firewalled host should
// surface "unreachable" quickly, not hang the request.
const PEER_TIMEOUT_MS = 4000;

/**
 * On-demand live snapshot for a PEER node. Resolves the account's on-chain
 * descriptor host (the allowlist — only operator-published hosts are reached)
 * and proxies the peer's `/api/v1/stats` + `/api/v1/status`, plus the in-flight
 * dispatch when a `?problem=<n>` global solution number is supplied. Mirrors
 * the self pipeline (indexer poll → telemetry) but fetched per request, since
 * arbitrary peers aren't polled. `reachable` is a first-class result: a
 * connection failure returns `{ reachable: false }` with HTTP 200 so the SPA
 * renders a "node data unreachable" notice rather than treating it as an error.
 */
export function registerNodeLiveRoute(app: Hono, opts: NodeLiveOptions): void {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());

  app.get("/api/node/:accountId/live", async (c) => {
    const accountId = c.req.param("accountId");
    const problemRaw = c.req.query("problem");
    const problem = problemRaw != null ? Number(problemRaw) : null;

    const unreachable = (): NodeLiveData => ({
      accountId,
      reachable: false,
      minerStats: null,
      modes: {},
      currentDispatch: null,
      fetchedAt: now().toISOString(),
    });

    const descriptor = await opts.db.getNodeDescriptor(accountId);
    const baseUrl = resolvePeerMinerRestUrl(descriptor);
    if (!baseUrl) return c.json(unreachable());

    // Probe stats + status concurrently. Each resolves to null on any failure.
    const [statsRaw, statusRaw] = await Promise.all([
      getJson(fetchImpl, `${baseUrl}/api/v1/stats`),
      getJson(fetchImpl, `${baseUrl}/api/v1/status`),
    ]);

    // Unreachable only when BOTH core probes failed to connect/parse.
    if (statsRaw == null && statusRaw == null) return c.json(unreachable());

    const minerStats: MinerStats | null =
      statsRaw != null ? parseMinerStatsPayload(statsRaw) : null;
    const modes: Record<string, ModeBreakdown> =
      statusRaw != null ? parseStatusModes((statusRaw as Record<string, unknown>)["modes"]) : {};
    const minerId = statusRaw != null ? parseStatusPrimaryMinerId(statusRaw) : null;

    const currentDispatch =
      minerId != null && problem != null && Number.isInteger(problem) && problem > 0
        ? await resolvePeerDispatch(fetchImpl, baseUrl, minerId, problem)
        : null;

    return c.json({
      accountId,
      reachable: true,
      minerStats,
      modes,
      currentDispatch,
      fetchedAt: now().toISOString(),
    } satisfies NodeLiveData);
  });
}

/**
 * Fetch + envelope-unwrap a peer JSON endpoint. Returns the inner payload, or
 * null on any failure (connection, non-2xx, `success:false`, parse) so callers
 * treat a flaky peer as simply absent data.
 */
async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown | null> {
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const parsed = (await res.json()) as { success?: boolean; data?: unknown };
    if (parsed && typeof parsed === "object" && parsed.success === false) return null;
    return parsed?.data ?? parsed;
  } catch {
    return null;
  }
}

/**
 * Resolve the peer's current dispatch by probing the in-flight problem and, if
 * empty, the just-completed one — the same two-probe strategy the self
 * telemetry route uses. Best-effort: returns null when neither has iterations.
 */
async function resolvePeerDispatch(
  fetchImpl: typeof fetch,
  baseUrl: string,
  minerId: string,
  currentSolutionNumber: number,
): Promise<CurrentDispatch | null> {
  const [cur, prev] = await Promise.all([
    fetchPeerAttempts(fetchImpl, baseUrl, minerId, currentSolutionNumber),
    currentSolutionNumber > 1
      ? fetchPeerAttempts(fetchImpl, baseUrl, minerId, currentSolutionNumber - 1)
      : Promise.resolve<MiningAttempt[]>([]),
  ]);
  if (cur.length > 0) {
    return { solutionNumber: currentSolutionNumber, attempts: cur, status: "in-flight" };
  }
  if (prev.length > 0) {
    return { solutionNumber: currentSolutionNumber - 1, attempts: prev, status: "completed" };
  }
  return null;
}

async function fetchPeerAttempts(
  fetchImpl: typeof fetch,
  baseUrl: string,
  minerId: string,
  solutionNumber: number,
): Promise<MiningAttempt[]> {
  const params = new URLSearchParams({
    miner_id: minerId,
    solution_number: String(solutionNumber),
  });
  const raw = await getJson(fetchImpl, `${baseUrl}/api/v1/mining/attempts?${params.toString()}`);
  if (raw == null) return [];
  try {
    return parseDispatchAttemptsApiResponse(raw);
  } catch {
    return [];
  }
}
