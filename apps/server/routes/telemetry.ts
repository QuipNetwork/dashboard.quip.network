// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Hono } from "hono";

import { TtlCache, type ICache } from "@quip/core/cache";
import type { DatabaseAdapter } from "@quip/core/db/adapter";
import { parseDispatchAttemptsApiResponse } from "@quip/core/miner-api";
import { resolveSelfMinerRestUrl } from "@quip/core/resolve-miner-rest";
import type {
  CurrentDispatch,
  MiningAttempt,
  NodeDescriptorRecord,
  NodeInfo,
  NodesSnapshot,
  TelemetryResponse,
  ValidatorAuthorshipRecord,
} from "@quip/shared/telemetry";
import { getGeoIpEnricher } from "../geo-ip";

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
// The telemetry payload is global to the deployment (no per-viewer state), so
// one process-wide snapshot serves every concurrent poller. A short TTL keeps
// staleness well under the indexer's own write cadence while collapsing N
// viewers' per-poll recompute into one. The server-side cache is independent
// of the `no-store` header below, which only stops *browsers* from caching.
const DEFAULT_CACHE_TTL_MS = 1000;

const SNAPSHOT_KEY = "telemetry";

interface TelemetryDeps {
  db: DatabaseAdapter;
  validatorRpcUrls: string[];
  // Injected clock — drives the snapshot timestamps (and the default cache's
  // freshness check), so tests can pin time deterministically.
  now?: () => number;
  // 0 disables the cache (every request rebuilds); used by tests for an
  // uncached baseline. Ignored when an explicit `cache` is injected.
  cacheTtlMs?: number;
  // The snapshot cache. Defaults to an in-process TtlCache; injectable so tests
  // (or alternative deployments) can supply their own ICache implementation.
  cache?: ICache<TelemetryResponse>;
}

export function registerTelemetryRoute(app: Hono, deps: TelemetryDeps): void {
  const { db, validatorRpcUrls } = deps;
  const now = deps.now ?? Date.now;
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cache = deps.cache ?? new TtlCache<TelemetryResponse>({ ttlMs: cacheTtlMs, now });

  app.get("/api/telemetry", async (c) => {
    const snapshot = await cache.read(SNAPSHOT_KEY, buildSnapshot);
    // Telemetry is a moving target — every poll returns different counters.
    // Without `no-store`, browsers can apply heuristic freshness to an opaque
    // JSON body and serve a cached response after a refocus, masking real
    // updates from the indexer.
    c.header("Cache-Control", "no-store");
    return c.json(snapshot);
  });

  async function buildSnapshot(): Promise<TelemetryResponse> {
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

    // Current-dispatch resolution. The in-flight problem is the global
    // solution_number = `LatestQBlockId + 1`, surfaced through
    // `chain_head.winning_solutions_count` for API compatibility. The miner
    // grinds that solution_number; the prior one is the just-completed
    // problem. Skip when the substrate worker hasn't written the count yet.
    const minerHardware = selfAddress ? hardwareByAccount.get(selfAddress) : undefined;
    const minerInternalId = minerHardware?.miners[0]?.id ?? null;
    const winningSolutionsCount = chainHead?.winningSolutionsCount ?? null;
    const currentDispatch: CurrentDispatch | null =
      selfAddress && minerInternalId && winningSolutionsCount !== null
        ? await resolveCurrentDispatch(minerInternalId, winningSolutionsCount + 1)
        : null;

    // Project per-account registry descriptors into the legacy
    // NodesSnapshot shape so the Compute Available view's TFLOPS/PFLOPS
    // surfaces keep their existing consumer contract. The descriptor
    // pipeline replaces the v0.2 HTTP-fanout survey, but the snapshot
    // shape is unchanged.
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
    const nowMs = now();
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

    return {
      blocks,
      selfAddress,
      indexer,
      serverTime: new Date(now()).toISOString(),
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
    } satisfies TelemetryResponse;
  }

  /**
   * Resolve which global solution_number the panel shows + whether it's
   * in-flight (MR !105).
   *
   * The miner is grinding `currentSolutionNumber` (= Σ proofsWon + 1); its
   * prior problem `currentSolutionNumber - 1` (= Σ proofsWon) was won
   * network-wide and is finished. Probe both: if the in-flight directory
   * has iterations the miner is actively working it; otherwise fall back to
   * the just-completed one for the brief window before the next directory
   * is written.
   *
   * Best-effort throughout: any failure path that ends with no iterations
   * returns null and the panel renders the empty state (which explains
   * "between dispatches" / "miner unreachable").
   */
  async function resolveCurrentDispatch(
    minerId: string,
    currentSolutionNumber: number,
  ): Promise<CurrentDispatch | null> {
    const [curAttempts, prevAttempts] = await Promise.all([
      fetchSolutionAttempts(minerId, currentSolutionNumber),
      currentSolutionNumber > 1
        ? fetchSolutionAttempts(minerId, currentSolutionNumber - 1)
        : Promise.resolve<MiningAttempt[]>([]),
    ]);
    if (curAttempts.length > 0) {
      return {
        solutionNumber: currentSolutionNumber,
        attempts: curAttempts,
        status: "in-flight",
      };
    }
    if (prevAttempts.length > 0) {
      return {
        solutionNumber: currentSolutionNumber - 1,
        attempts: prevAttempts,
        status: "completed",
      };
    }
    return null;
  }

  async function fetchSolutionAttempts(
    minerId: string,
    solutionNumber: number,
  ): Promise<MiningAttempt[]> {
    const baseUrl = resolveSelfMinerRestUrl(validatorRpcUrls);
    if (!baseUrl) return [];
    const params = new URLSearchParams({
      miner_id: minerId,
      solution_number: String(solutionNumber),
    });
    const url = `${baseUrl}/api/v1/mining/attempts?${params.toString()}`;
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return [];
      const parsed = (await res.json()) as { success?: boolean; data?: unknown };
      if (parsed && typeof parsed === "object" && parsed.success === false) return [];
      return parseDispatchAttemptsApiResponse(parsed?.data ?? parsed);
    } catch {
      return [];
    }
  }

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
}
