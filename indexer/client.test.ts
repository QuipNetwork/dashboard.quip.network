// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { QuipClient } from "./client";

// These fixtures are copy-pasted from real responses captured against
// https://qpu-1.nodes.quip.network on 2026-04-22 (v0.0.6 dashboard, post-v4
// node telemetry). The point of this test is to pin the hash-valued epoch
// id shape at the client boundary so pre-cutover numeric-parse regressions
// (Number("e0a08eef1dfff726") → NaN) can't come back.

const LIVE_STATUS = {
  success: true,
  data: {
    epochs: ["2d09646aa4a2fbd7", "329c3c4e821fb776", "e0a08eef1dfff726", "f1d71b7d890e16e4"],
    latest_epoch: "e0a08eef1dfff726",
    latest_block_index: 186,
    total_blocks: 888,
    node_count: 242,
    active_node_count: 184,
    nodes_updated_at: "2026-04-22T23:58:10.185971+00:00",
  },
  timestamp: 1776902326,
};

const LIVE_EPOCHS = {
  success: true,
  data: {
    epochs: [
      {
        epoch: "2d09646aa4a2fbd7",
        block_count: 3,
        first_block: 1,
        last_block: 3,
        status: "stale_fork",
      },
      {
        epoch: "e0a08eef1dfff726",
        block_count: 186,
        first_block: 1,
        last_block: 186,
        status: "live",
      },
      // Exercises the narrower: unknown status falls back to stale_fork
      // and does not crash the parse.
      {
        epoch: "ffffffffffffffff",
        block_count: 1,
        first_block: 1,
        last_block: 1,
        status: "orphaned",
      },
    ],
  },
  timestamp: 1776902327,
};

function fetchStubbed(map: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [suffix, body] of Object.entries(map)) {
      if (url.endsWith(suffix)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

describe("QuipClient against live-format telemetry", () => {
  it("keeps latestEpoch as the verbatim hash string", async () => {
    const client = new QuipClient({
      baseUrl: "https://qpu-1.example.com",
      fetchImpl: fetchStubbed({ "/api/v1/telemetry/status": LIVE_STATUS }),
    });
    const res = await client.getStatus(null);
    expect(res.body?.latestEpoch).toBe("e0a08eef1dfff726");
    // Defensive: make absolutely sure no Number() coercion snuck back in.
    expect(typeof res.body?.latestEpoch).toBe("string");
    expect(res.body?.epochs).toContain("2d09646aa4a2fbd7");
  });

  it("parses each epoch entry with a string id and narrowed status", async () => {
    const client = new QuipClient({
      baseUrl: "https://qpu-1.example.com",
      fetchImpl: fetchStubbed({ "/api/v1/telemetry/epochs": LIVE_EPOCHS }),
    });
    const body = await client.getEpochs();
    expect(body.epochs).toHaveLength(3);
    const canonical = body.epochs.find((e) => e.epoch === "e0a08eef1dfff726");
    expect(canonical?.status).toBe("live");
    const stale = body.epochs.find((e) => e.epoch === "2d09646aa4a2fbd7");
    expect(stale?.status).toBe("stale_fork");
    // Unknown status narrows safely.
    const unknown = body.epochs.find((e) => e.epoch === "ffffffffffffffff");
    expect(unknown?.status).toBe("stale_fork");
  });

  it("builds block-fetch URLs with the hash epoch id verbatim", async () => {
    let seenUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seenUrl = typeof input === "string" ? input : input.toString();
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const client = new QuipClient({
      baseUrl: "https://qpu-1.example.com",
      fetchImpl,
    });
    await client.getBlock("e0a08eef1dfff726", 7);
    expect(seenUrl).toContain("/api/v1/telemetry/epochs/e0a08eef1dfff726/blocks/7");
  });
});
