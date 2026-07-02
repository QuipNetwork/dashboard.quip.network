// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { NodeDescriptorRecord, NodeLiveData } from "@quip/shared/telemetry";

import { registerNodeLiveRoute } from "./node-live";

function descriptor(accountId: string, host: string | undefined): NodeDescriptorRecord {
  return {
    accountId,
    blockNumber: "1",
    blockHash: "0xb",
    extrinsicIndex: 0,
    blockTimestamp: 0,
    firstBlockTimestamp: 0,
    observedAt: "2026-06-30T00:00:00Z",
    descriptor: {
      schema: "quip.node_descriptor.v1",
      descriptorVersion: 1,
      nodeName: "peer",
      ...(host === undefined ? {} : { publicHost: host, publicPort: 8088 }),
    },
  };
}

function dbWith(record: NodeDescriptorRecord | null) {
  return { getNodeDescriptor: async () => record };
}

const STATS_OK = {
  success: true,
  data: { controller: { heads_observed: 7, proofs_submitted: 5 } },
};
const STATUS_OK = {
  success: true,
  data: { miners: [{ id: "peer-CPU-1", type: "cpu" }], modes: {} },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Mock fetch routing on the request path.
function mockFetch(handlers: Record<string, () => Promise<Response> | Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [needle, handler] of Object.entries(handlers)) {
      if (url.includes(needle)) return handler();
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

async function callLive(app: Hono, account: string, query = ""): Promise<NodeLiveData> {
  const res = await app.request(`/api/node/${account}/live${query}`);
  return (await res.json()) as NodeLiveData;
}

describe("GET /api/node/:accountId/live", () => {
  test("reachable=false when the account has no descriptor host", async () => {
    const app = new Hono();
    registerNodeLiveRoute(app, {
      db: dbWith(descriptor("5GNoHost", undefined)),
      fetchImpl: mockFetch({}),
    });
    const body = await callLive(app, "5GNoHost");
    expect(body.reachable).toBe(false);
    expect(body.minerStats).toBeNull();
  });

  test("proxies stats + modes when the peer is reachable", async () => {
    const app = new Hono();
    registerNodeLiveRoute(app, {
      db: dbWith(descriptor("5GPeer", "1.2.3.4")),
      fetchImpl: mockFetch({
        "/api/v1/stats": () => jsonResponse(STATS_OK),
        "/api/v1/status": () => jsonResponse(STATUS_OK),
      }),
    });
    const body = await callLive(app, "5GPeer");
    expect(body.reachable).toBe(true);
    expect(body.minerStats?.proofsSubmitted).toBe(5);
    expect(body.modes).toEqual({});
  });

  test("reachable=false when the peer connection throws", async () => {
    const app = new Hono();
    registerNodeLiveRoute(app, {
      db: dbWith(descriptor("5GDown", "10.0.0.9")),
      fetchImpl: mockFetch({
        "/api/v1": () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    });
    const body = await callLive(app, "5GDown");
    expect(body.reachable).toBe(false);
  });

  test("resolves the in-flight dispatch when a problem number is supplied", async () => {
    const attempts = {
      success: true,
      data: {
        submission: { solution_number: 42 },
        attempts: [
          { iter: 0, best_energy_milli: -14000, result_kind: "stored", miner_type: "cpu" },
        ],
      },
    };
    const app = new Hono();
    registerNodeLiveRoute(app, {
      db: dbWith(descriptor("5GPeer", "1.2.3.4")),
      fetchImpl: mockFetch({
        "/api/v1/stats": () => jsonResponse(STATS_OK),
        "/api/v1/status": () => jsonResponse(STATUS_OK),
        "/api/v1/mining/attempts": () => jsonResponse(attempts),
      }),
    });
    const body = await callLive(app, "5GPeer", "?problem=42");
    expect(body.currentDispatch?.solutionNumber).toBe(42);
    expect(body.currentDispatch?.status).toBe("in-flight");
    expect(body.currentDispatch?.attempts.length).toBeGreaterThan(0);
  });
});
