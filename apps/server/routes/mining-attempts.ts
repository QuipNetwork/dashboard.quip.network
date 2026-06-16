// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Hono } from "hono";

import { parseMiningAttemptsApiResponse } from "@quip/core/miner-api";
import { resolveSelfMinerRestUrl } from "@quip/core/resolve-miner-rest";

// Modal proxy: fetches `/api/v1/mining/attempts?solution_number=N` from
// the local operator's miner-REST endpoint (resolved per-request via the
// on-chain descriptor or RPC-URL fallback) and re-shapes to camelCase.
// Kept here rather than calling the miner directly from the SPA because
// the miner's REST endpoint may not be reachable from the operator's
// browser (private network, no CORS).
//
// Returns 404 when the miner returns 404; 502 on any other upstream
// failure so the SPA can distinguish "no such submission" from
// "miner unreachable". Returns 503 when no miner-REST URL can be
// resolved yet (no selfAddress / no descriptor).
export function registerMiningAttemptsRoute(app: Hono, validatorRpcUrls: string[]): void {
  app.get("/api/mining/attempts/:solutionNumber", async (c) => {
    const raw = c.req.param("solutionNumber");
    const solutionNumber = Number(raw);
    if (
      !Number.isFinite(solutionNumber) ||
      solutionNumber <= 0 ||
      !Number.isInteger(solutionNumber)
    ) {
      return c.json({ error: "invalid solution_number" }, 400);
    }
    const baseUrl = resolveSelfMinerRestUrl(validatorRpcUrls);
    if (!baseUrl) {
      return c.json({ error: "miner REST endpoint not resolvable yet" }, 503);
    }
    const url = `${baseUrl}/api/v1/mining/attempts?solution_number=${solutionNumber}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { accept: "application/json" } });
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
}
