// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared fetch hook for `GET /api/miner-wins` — all-time per-miner win
// aggregates from the indexed `blocks` table, computed server-side in one
// GROUP BY (same pattern as the difficulty-history chart data). Every
// "qblocks won" surface reads this dataset so the numbers agree by
// construction; the on-chain lifetime `proofsWon` counter is a distinct
// measure and is labeled "(lifetime, on-chain)" where shown.

import { useEffect, useMemo, useState } from "react";

import { useTelemetryClient } from "@/services/telemetry-client";
import type { MinerWinsRow } from "@quip/shared/telemetry";

export interface MinerWinsState {
  // Wins descending, as served.
  rows: MinerWinsRow[];
  // rows indexed by minerId for O(1) per-account lookups.
  byMiner: ReadonlyMap<string, MinerWinsRow>;
  loading: boolean;
  error: string | null;
}

const REFRESH_MS = 60_000;

export function useMinerWins(opts: { refreshMs?: number } = {}): MinerWinsState {
  const client = useTelemetryClient();
  const refreshMs = opts.refreshMs ?? REFRESH_MS;
  const [rows, setRows] = useState<MinerWinsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const resp = await client.fetchMinerWins(ac.signal);
        if (cancelled) return;
        setRows(resp.rows);
        setLoading(false);
        setError(null);
      } catch (err) {
        if (cancelled || ac.signal.aborted) return;
        setLoading(false);
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    void load();
    const timer = setInterval(() => void load(), refreshMs);
    return () => {
      cancelled = true;
      ac.abort();
      clearInterval(timer);
    };
  }, [client, refreshMs]);

  const byMiner = useMemo(() => new Map(rows.map((r) => [r.minerId, r])), [rows]);

  return { rows, byMiner, loading, error };
}
