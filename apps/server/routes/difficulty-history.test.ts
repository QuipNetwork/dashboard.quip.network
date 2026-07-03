// SPDX-License-Identifier: AGPL-3.0-or-later
//
// /api/difficulty-history?since=<iso> (spec §10.5, task #24): the window rows
// PLUS one anchor row at-or-before the cutoff, so a range shorter than the
// current stable-difficulty stretch still renders the prevailing step instead
// of an empty chart.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { DatabaseAdapter } from "@quip/core/db/adapter";
import { newInMemoryAdapter } from "@quip/core/test-helpers";
import type { DifficultyRecord } from "@quip/shared/telemetry";
import { createApp } from "../app";

let db: DatabaseAdapter;
let app: ReturnType<typeof createApp>;

const snap = (
  block: string,
  energy: number,
  observedAt: string,
  source: "block" | "poll" = "block",
): DifficultyRecord => ({
  observedAtBlock: block,
  difficultyEnergy: energy,
  minDiversity: 0,
  minSolutions: 1,
  observedAt,
  topologyHash: null,
  source,
});

beforeEach(async () => {
  db = await newInMemoryAdapter();
  app = createApp({ db, validatorRpcUrls: ["ws://test:9944"], enableStatic: false });
  await db.insertDifficultySnapshot(snap("10", -10, "2026-06-01T00:00:00.000Z"));
  await db.insertDifficultySnapshot(snap("20", -20, "2026-06-15T00:00:00.000Z"));
  await db.insertDifficultySnapshot(snap("30", -30, "2026-07-01T00:00:00.000Z", "poll"));
});

afterEach(async () => {
  await db.disconnect();
});

interface HistoryPayload {
  since: string;
  anchor: DifficultyRecord | null;
  rows: DifficultyRecord[];
}

async function get(query: string): Promise<Response> {
  return app.fetch(new Request(`http://test/api/difficulty-history${query}`));
}

describe("GET /api/difficulty-history", () => {
  test("returns in-window rows ascending plus the anchor before the cutoff", async () => {
    const res = await get("?since=2026-06-10T00:00:00.000Z");
    expect(res.status).toBe(200);
    const body = (await res.json()) as HistoryPayload;
    expect(body.rows.map((r) => r.observedAtBlock)).toEqual(["20", "30"]);
    expect(body.anchor?.observedAtBlock).toBe("10"); // prevailing step
  });

  test("a stable-difficulty short window still carries the prevailing value", async () => {
    // Nothing after 2026-07-02, so the window is empty — the anchor alone
    // lets the chart render the current step.
    const res = await get("?since=2026-07-02T00:00:00.000Z");
    const body = (await res.json()) as HistoryPayload;
    expect(body.rows).toEqual([]);
    expect(body.anchor?.observedAtBlock).toBe("30");
  });

  test("anchor is null before the first measurement", async () => {
    const res = await get("?since=2026-01-01T00:00:00.000Z");
    const body = (await res.json()) as HistoryPayload;
    expect(body.rows).toHaveLength(3);
    expect(body.anchor).toBeNull();
  });

  test("rejects a missing or malformed since", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get("?since=yesterday")).status).toBe(400);
  });
});
