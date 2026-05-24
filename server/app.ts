// SPDX-License-Identifier: AGPL-3.0-or-later

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { DatabaseAdapter } from "../api/db/adapter";
import { parseDispatchAttemptsApiResponse, parseMiningAttemptsApiResponse } from "../api/miner-api";
import type {
  CurrentDispatch,
  MiningAttempt,
  NodeDescriptorRecord,
  NodeInfo,
  NodesSnapshot,
  TelemetryResponse,
  ValidatorAuthorshipRecord,
} from "../src/types/telemetry";

import { getGeoIpEnricher } from "./geo-ip";

// Cap on submission rows surfaced in /api/telemetry. The MyNode panel
// shows the most recent and offers click-through to the modal for older
// ones, so a deeper history is just bytes on the wire. 20 fits one
// screenful of rows comfortably.
const RECENT_MINING_SUBMISSIONS_LIMIT = 20;

// "Online" threshold for the Active Validators table. A validator counts
// as online when its most recent authored head is within this window of
// the request wall-clock. 3 minutes is roughly 30x the 6s block time on
// quip-protocol-rs spec 101 — short enough to catch operator outages,
// long enough that BABE slot skips don't briefly flap a healthy node.
const VALIDATOR_ONLINE_WINDOW_MS = 3 * 60 * 1000;

interface StaticOptions {
  root?: string;
  path?: string;
}

type ServeStaticFactory = (options: StaticOptions) => MiddlewareHandler;

export interface CreateAppOptions {
  db: DatabaseAdapter;
  enableStatic?: boolean;
  staticDir?: string;
  /**
   * Factory producing a Hono static-file middleware given (root, path?).
   * Injected by `server/main.ts` so this module never imports `hono/bun` —
   * the Netlify runtime (Node) cannot load Bun-only adapters at module scope.
   */
  serveStatic?: ServeStaticFactory;
}

export function createApp(options: CreateAppOptions): Hono {
  const { db, enableStatic = false, staticDir = "./dist", serveStatic } = options;
  const app = new Hono();

  app.get("/api/telemetry", async (c) => {
    const [
      blocks,
      selfAddress,
      indexer,
      chainHead,
      babeEpoch,
      babeAuthorities,
      chainMiners,
      recentDifficulty,
      allHardware,
      authorship,
      nodeDescriptors,
    ] = await Promise.all([
      // Page-1 default; the UI can request later pages once pagination lands.
      db.getRecentBlocks(500, 0),
      db.getSelfAddress(),
      db.getIndexerObservability(),
      db.getChainHead(),
      db.getCurrentBabeEpoch(),
      db.getActiveBabeAuthorities(),
      db.getChainMiners(),
      db.getRecentDifficulty(50),
      db.getAllMinerHardware(),
      db.getValidatorAuthorship(),
      db.getAllNodeDescriptors(),
    ]);

    // Recent submissions by the locally-polled miner — drives the
    // "Recent Performance" panel. Empty until either selfAddress
    // resolves (first /status poll) or the miner emits its first
    // submission. The indexer keys by selfAddress so multi-miner
    // dashboards never see other miners' submissions here.
    const recentMiningSubmissions = selfAddress
      ? await db.getRecentMiningSubmissions(selfAddress, RECENT_MINING_SUBMISSIONS_LIMIT)
      : [];

    // Lifetime "Problems Attempted" — distinct solution_ids with iterations
    // recorded. Counted at the DB so the value isn't bounded by the recent-
    // submissions window above.
    const selfProblemsAttempted = selfAddress
      ? await db.countMiningSubmissionsWithAttempts(selfAddress)
      : 0;

    // Hardware lookup feeds two downstream concerns: the chain-miner
    // join (every row) and the current-dispatch fetch (self only). Build
    // once.
    const hardwareByAccount = new Map(allHardware.map((h) => [h.accountId, h]));

    // Current-dispatch resolution. The miner's counters give us
    // unambiguous status:
    //   - `contextsDispatched` (N): total dispatches started
    //   - `resultsReceived` (M): total dispatches that produced a result
    // If M < N, dispatch N is in-flight (the miner is grinding it).
    // If M == N, dispatch N is completed; the miner may or may not have
    // started N+1. We probe N+1 to find out.
    const minerHardware = selfAddress ? hardwareByAccount.get(selfAddress) : undefined;
    const minerInternalId = minerHardware?.miners[0]?.id ?? null;
    const contextsDispatched = indexer?.minerStats?.contextsDispatched ?? null;
    const resultsReceived = indexer?.minerStats?.resultsReceived ?? null;
    const currentDispatch: CurrentDispatch | null =
      selfAddress &&
      minerInternalId &&
      contextsDispatched !== null &&
      resultsReceived !== null &&
      contextsDispatched > 0
        ? await resolveCurrentDispatch(minerInternalId, contextsDispatched, resultsReceived)
        : null;

    // Project per-account chain descriptors into the legacy NodesSnapshot
    // shape so the Compute Available view's TFLOPS/PFLOPS surfaces keep
    // their existing consumer contract. The descriptor pipeline (chain
    // remarks, signed by operator) replaces the v0.2 HTTP-fanout survey
    // but the snapshot shape is unchanged.
    const projected = projectDescriptorsToSnapshot(nodeDescriptors);
    // Geo-IP enrich the projection: resolve each node's `publicHost` to a
    // lat/lng via DNS + MaxMind. Cache-amortised, so warm calls are
    // synchronous in practice. No-op when geo backends are unavailable
    // (the map then renders no markers).
    const enricher = await getGeoIpEnricher();
    const nodes = await enricher.enrichSnapshot(projected);

    // Join chain_miners → miner_hardware on accountId so the UI can render
    // a per-row "telemetry node" link without a second fetch. Today only
    // self has a miner_hardware row (source='self'); future peer-query and
    // chain-surface upgrades populate other entries.
    const enrichedMiners = chainMiners.map((m) => ({
      ...m,
      telemetryNodeAddress: hardwareByAccount.get(m.accountId)?.nodeId ?? null,
      hardware: hardwareByAccount.get(m.accountId) ?? null,
    }));

    // Join the active BABE authority set → per-validator authorship stats.
    // Validators that haven't authored a head the indexer has seen surface
    // with 0 counters and `online: false`; the row still appears in the
    // table so operators see their full authority set, not just the busy
    // ones.
    const authorshipByAccount = new Map(authorship.map((a) => [a.accountId, a]));
    const nowMs = Date.now();
    const validators: ValidatorAuthorshipRecord[] = babeAuthorities.map((a) => {
      const stats = authorshipByAccount.get(a.accountId);
      const lastAuthoredAt = stats?.lastAuthoredAt ?? null;
      const ageMs = lastAuthoredAt ? nowMs - Date.parse(lastAuthoredAt) : Infinity;
      return {
        accountId: a.accountId,
        blocksAuthored: stats?.blocksAuthored ?? 0,
        blocksAuthoredWithPow: stats?.blocksAuthoredWithPow ?? 0,
        lastAuthoredBlock: stats?.lastAuthoredBlock ?? null,
        lastAuthoredAt,
        online: ageMs < VALIDATOR_ONLINE_WINDOW_MS,
      };
    });

    return c.json({
      blocks,
      selfAddress,
      indexer,
      serverTime: new Date().toISOString(),
      chainHead,
      babeEpoch,
      babeAuthorities,
      chainMiners: enrichedMiners,
      recentDifficulty,
      validators,
      nodes,
      nodeDescriptors,
      recentMiningSubmissions,
      selfProblemsAttempted,
      currentDispatch,
    } satisfies TelemetryResponse);
  });

  /**
   * Resolve which dispatch the panel shows + whether it's in-flight.
   *
   * - `M < N`: dispatch N has no result yet → in-flight on N. One fetch.
   * - `M == N`: dispatch N is complete; probe N+1 in case the miner
   *   already started the next one. Two parallel fetches.
   *
   * Best-effort throughout: any failure path that ends with no
   * iterations returns null and the panel renders the empty state
   * (which explains "between dispatches" / "miner unreachable").
   */
  async function resolveCurrentDispatch(
    minerId: string,
    contextsDispatched: number,
    resultsReceived: number,
  ): Promise<CurrentDispatch | null> {
    // Dispatch N is in-flight when results lag behind. The controller
    // bumps contextsDispatched when it enqueues the next problem, but
    // the miner doesn't write attempt rows for N until SA emits its
    // first iteration — so probe both N and N-1 to cover the race
    // window where N is queued but N-1 is the one still grinding.
    if (resultsReceived < contextsDispatched) {
      const [topAttempts, prevAttempts] = await Promise.all([
        fetchDispatchAttempts(minerId, contextsDispatched),
        fetchDispatchAttempts(minerId, contextsDispatched - 1),
      ]);
      if (topAttempts.length > 0) {
        return {
          dispatchId: contextsDispatched,
          attempts: topAttempts,
          status: "in-flight",
        };
      }
      if (prevAttempts.length > 0) {
        return {
          dispatchId: contextsDispatched - 1,
          attempts: prevAttempts,
          status: "in-flight",
        };
      }
      return null;
    }
    // Dispatch N is complete; the miner may have started N+1 already.
    const [nextAttempts, curAttempts] = await Promise.all([
      fetchDispatchAttempts(minerId, contextsDispatched + 1),
      fetchDispatchAttempts(minerId, contextsDispatched),
    ]);
    if (nextAttempts.length > 0) {
      return {
        dispatchId: contextsDispatched + 1,
        attempts: nextAttempts,
        status: "in-flight",
      };
    }
    if (curAttempts.length > 0) {
      return {
        dispatchId: contextsDispatched,
        attempts: curAttempts,
        status: "completed",
      };
    }
    return null;
  }

  async function fetchDispatchAttempts(
    minerId: string,
    dispatchId: number,
  ): Promise<MiningAttempt[]> {
    const baseUrl = process.env.QUIP_NODE_URL;
    if (!baseUrl) return [];
    const headers: Record<string, string> = { accept: "application/json" };
    const token = process.env.QUIP_NODE_TOKEN;
    if (token) headers["authorization"] = `Bearer ${token}`;
    const params = new URLSearchParams({
      miner_id: minerId,
      dispatch_id: String(dispatchId),
    });
    const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/mining/attempts?${params.toString()}`;
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
      if (!res.ok) return [];
      const parsed = (await res.json()) as { success?: boolean; data?: unknown };
      if (parsed && typeof parsed === "object" && parsed.success === false) return [];
      return parseDispatchAttemptsApiResponse(parsed?.data ?? parsed);
    } catch {
      return [];
    }
  }

  // Modal proxy: fetches `/api/v1/mining/attempts?solution_id=N` from the
  // miner pointed to by QUIP_NODE_URL and re-shapes to camelCase. Kept
  // here rather than calling the miner directly from the SPA because:
  //   - QUIP_NODE_URL may not be reachable from the operator's browser
  //     (private network, no CORS), and
  //   - QUIP_NODE_TOKEN (if set) lives in the server env and must NOT
  //     ship to the browser.
  // Returns 404 when the miner returns 404; 502 on any other upstream
  // failure so the SPA can distinguish "no such submission" from
  // "miner unreachable".
  app.get("/api/mining/attempts/:solutionId", async (c) => {
    const raw = c.req.param("solutionId");
    const solutionId = Number(raw);
    if (!Number.isFinite(solutionId) || solutionId <= 0 || !Number.isInteger(solutionId)) {
      return c.json({ error: "invalid solution_id" }, 400);
    }
    const baseUrl = process.env.QUIP_NODE_URL;
    if (!baseUrl) {
      return c.json({ error: "QUIP_NODE_URL not configured" }, 503);
    }
    const headers: Record<string, string> = { accept: "application/json" };
    const token = process.env.QUIP_NODE_TOKEN;
    if (token) headers["authorization"] = `Bearer ${token}`;
    const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/mining/attempts?solution_id=${solutionId}`;
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (e) {
      return c.json(
        { error: "upstream unreachable", detail: e instanceof Error ? e.message : String(e) },
        502,
      );
    }
    if (res.status === 404) return c.json({ error: "not found" }, 404);
    if (!res.ok) {
      return c.json({ error: `upstream ${res.status}` }, 502);
    }
    const parsed = (await res.json()) as { success?: boolean; data?: unknown; error?: string };
    if (parsed && typeof parsed === "object" && parsed.success === false) {
      return c.json({ error: parsed.error ?? "upstream reported failure" }, 502);
    }
    try {
      const envelope = parseMiningAttemptsApiResponse(parsed?.data ?? parsed);
      // Stamp observedAt at proxy time — the modal doesn't read it, but
      // the type contract requires a string.
      envelope.submission.observedAt = new Date().toISOString();
      return c.json(envelope);
    } catch (e) {
      return c.json(
        { error: "upstream parse failed", detail: e instanceof Error ? e.message : String(e) },
        502,
      );
    }
  });

  app.get("/api/health", async (c) => {
    // v6 drops the dual-cursor epoch model and the peer list. Health is now
    // an indexer-heartbeat surface — null fields mean the indexer has not
    // completed its first poll yet (or chain WSS has never connected).
    const obs = await db.getIndexerObservability();
    return c.json({
      ok: true,
      lastStatusFetchAt: obs?.lastStatusFetchAt ?? null,
      lastBlockInsertAt: obs?.lastBlockInsertAt ?? null,
      lastSubstrateEventAt: obs?.lastSubstrateEventAt ?? null,
      chainConnected: obs?.chainConnected ?? false,
    });
  });

  // Project the descriptor-worker's per-account rows into the legacy
  // NodesSnapshot shape the Compute Available view already consumes.
  // Field ownership per DASHBOARDPLAN.md:
  //   - chain-derived: address (SS58), firstSeen, lastSeen (block timestamps)
  //   - operator self-asserted: nodeName, publicHost, runtime, miners,
  //     systemInfo (from descriptor)
  //   - dashboard placeholders: status="active" (we have no liveness signal
  //     yet — the chain doesn't beat), lastHeartbeat=null (same)
  function projectDescriptorsToSnapshot(records: NodeDescriptorRecord[]): NodesSnapshot | null {
    if (records.length === 0) return null;
    const nodes: Record<string, NodeInfo> = {};
    let mostRecentObservedAt = "";
    for (const r of records) {
      const d = r.descriptor;
      nodes[r.accountId] = {
        address: r.accountId,
        // No chain-side liveness signal; treat any registered descriptor
        // as "active" until we have a heartbeat-equivalent surface.
        status: "active",
        firstSeen: r.firstBlockTimestamp,
        lastSeen: r.blockTimestamp,
        lastHeartbeat: null,
        nodeName: d.nodeName,
        publicHost: d.publicHost,
        publicPort: d.publicPort,
        autoMine: d.autoMine,
        logLevel: d.logLevel,
        runtime: d.runtime,
        miners: d.miners,
        systemInfo: d.systemInfo,
      };
      if (r.observedAt > mostRecentObservedAt) mostRecentObservedAt = r.observedAt;
    }
    return {
      updatedAt: mostRecentObservedAt || new Date().toISOString(),
      nodeCount: records.length,
      // No liveness distinction yet; will refine once we have a chain-side
      // heartbeat or join against recent validator authorship.
      activeCount: records.length,
      nodes,
    };
  }

  if (enableStatic) {
    if (!serveStatic) {
      throw new Error(
        "[server] enableStatic=true requires a serveStatic factory (see server/main.ts)",
      );
    }
    app.use("/*", serveStatic({ root: staticDir }));
    app.get("/*", serveStatic({ root: staticDir, path: "index.html" }));
  }

  return app;
}
