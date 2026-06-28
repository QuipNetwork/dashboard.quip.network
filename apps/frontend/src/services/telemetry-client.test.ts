// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type { MiningAttemptsResponse, TelemetryResponse } from "@quip/shared/telemetry";
import { HttpTelemetryClient } from "./telemetry-client";

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(responder: (url: string) => Response): {
  fetch: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : "";
    calls.push({ url, init });
    return responder(url);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const TELEMETRY_BODY = { blocks: [], selfAddress: "5GPP" } as unknown as TelemetryResponse;
const ATTEMPTS_BODY = {
  submission: { solutionNumber: 7 },
  attempts: [],
} as unknown as MiningAttemptsResponse;

describe("HttpTelemetryClient.fetchTelemetry", () => {
  it("requests /api/telemetry and returns the parsed body", async () => {
    const { fetch, calls } = fakeFetch(() => json(TELEMETRY_BODY));
    const client = new HttpTelemetryClient({ fetch });

    const out = await client.fetchTelemetry();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/telemetry");
    expect(out).toEqual(TELEMETRY_BODY);
  });

  it("prefixes baseUrl when configured (breaks the hard-coded-URL coupling)", async () => {
    const { fetch, calls } = fakeFetch(() => json(TELEMETRY_BODY));
    const client = new HttpTelemetryClient({ fetch, baseUrl: "https://example.test" });

    await client.fetchTelemetry();

    expect(calls[0]?.url).toBe("https://example.test/api/telemetry");
  });

  it("forwards an AbortSignal when given", async () => {
    const { fetch, calls } = fakeFetch(() => json(TELEMETRY_BODY));
    const client = new HttpTelemetryClient({ fetch });
    const ac = new AbortController();

    await client.fetchTelemetry(ac.signal);

    expect(calls[0]?.init?.signal).toBe(ac.signal);
  });

  it("throws `HTTP <status>` on a non-2xx response", async () => {
    const { fetch } = fakeFetch(() => new Response("nope", { status: 503 }));
    const client = new HttpTelemetryClient({ fetch });

    await expect(client.fetchTelemetry()).rejects.toThrow("HTTP 503");
  });
});

describe("HttpTelemetryClient.fetchMiningAttempts", () => {
  it("requests /api/mining/attempts/:n and returns the parsed body", async () => {
    const { fetch, calls } = fakeFetch(() => json(ATTEMPTS_BODY));
    const client = new HttpTelemetryClient({ fetch });

    const out = await client.fetchMiningAttempts(7);

    expect(calls[0]?.url).toBe("/api/mining/attempts/7");
    expect(out).toEqual(ATTEMPTS_BODY);
  });

  it("maps 404 to a miner-specific not-found message", async () => {
    const { fetch } = fakeFetch(() => new Response("", { status: 404 }));
    const client = new HttpTelemetryClient({ fetch });

    await expect(client.fetchMiningAttempts(7)).rejects.toThrow("solution #7 not found on miner");
  });

  it("surfaces the server's error body on other non-2xx responses", async () => {
    const { fetch } = fakeFetch(() => json({ error: "miner unreachable" }, 502));
    const client = new HttpTelemetryClient({ fetch });

    await expect(client.fetchMiningAttempts(7)).rejects.toThrow("miner unreachable");
  });

  it("falls back to `HTTP <status>` when the error body has no message", async () => {
    const { fetch } = fakeFetch(() => new Response("boom", { status: 500 }));
    const client = new HttpTelemetryClient({ fetch });

    await expect(client.fetchMiningAttempts(7)).rejects.toThrow("HTTP 500");
  });
});

describe("HttpTelemetryClient.fetchBlocks", () => {
  it("requests /api/blocks with limit and offset and unwraps the page", async () => {
    const { fetch, calls } = fakeFetch(() => json({ blocks: [{ blockHash: "0xa" }] }));
    const client = new HttpTelemetryClient({ fetch });

    const out = await client.fetchBlocks(50, 100);

    expect(calls[0]?.url).toBe("/api/blocks?limit=50&offset=100");
    expect(out).toHaveLength(1);
  });

  it("throws `HTTP <status>` on a non-2xx response", async () => {
    const { fetch } = fakeFetch(() => new Response("nope", { status: 500 }));
    const client = new HttpTelemetryClient({ fetch });

    await expect(client.fetchBlocks(10, 0)).rejects.toThrow("HTTP 500");
  });
});
