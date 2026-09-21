// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type {
  CurrentDispatch,
  MiningAttemptsResponse,
  NodesDocument,
  TelemetryResponse,
} from "@quip/shared/telemetry";
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

const TELEMETRY_BODY: TelemetryResponse = {
  selfAddress: "5GPP",
  indexer: null,
  serverTime: "2026-05-19T12:00:00Z",
  chainHead: null,
  babeEpoch: null,
  babeAuthorities: [],
  chainMiners: [],
  recentDifficulty: [],
  mineableTopologies: [],
  validators: [],
  recentMiningSubmissions: [],
  selfProblemsAttempted: 0,
  files: {
    qblocksManifest: "/files/qblocks/metadata.json",
    nodesSnapshot: "/files/nodes/snapshot.json",
    minerCurrentDispatch: null,
  },
};
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

  it("normalizes a configured API base before requesting routes", async () => {
    const { fetch, calls } = fakeFetch(() => json(TELEMETRY_BODY));
    const client = new HttpTelemetryClient({ fetch, baseUrl: "https://example.test/" });
    await client.fetchTelemetry();
    await client.fetchBlocks(5, 0);
    expect(calls.map((call) => call.url)).toEqual([
      "https://example.test/api/telemetry",
      "https://example.test/api/blocks?limit=5&offset=0",
    ]);
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

describe("HttpTelemetryClient.fetchMinerWins", () => {
  it("requests /api/miner-wins and returns the parsed body", async () => {
    const rows = [
      {
        minerId: "5A",
        wins: 2,
        bestEnergy: -2,
        avgMiningTime: 10,
        lastWonAt: 1,
        lastWonQblockId: "1",
        lastWonBlockHash: "0x1",
      },
    ];
    const { fetch, calls } = fakeFetch(() => json({ rows }));
    const client = new HttpTelemetryClient({ fetch });

    const out = await client.fetchMinerWins();

    expect(calls[0]?.url).toBe("/api/miner-wins");
    expect(out.rows).toEqual(rows);
  });

  it("throws `HTTP <status>` on a non-2xx response", async () => {
    const { fetch } = fakeFetch(() => new Response("nope", { status: 502 }));
    const client = new HttpTelemetryClient({ fetch });

    await expect(client.fetchMinerWins()).rejects.toThrow("HTTP 502");
  });
});

describe("HttpTelemetryClient.fetchNodeSummary", () => {
  it("requests the encoded account's summary and returns the parsed body", async () => {
    const body = { summary: null, lastWonBlock: null };
    const { fetch, calls } = fakeFetch(() => json(body));
    const client = new HttpTelemetryClient({ fetch });

    const out = await client.fetchNodeSummary("5A/B");

    expect(calls[0]?.url).toBe("/api/node/5A%2FB/summary");
    expect(out).toEqual(body);
  });

  it("throws `HTTP <status>` on a non-2xx response", async () => {
    const { fetch } = fakeFetch(() => new Response("nope", { status: 503 }));
    const client = new HttpTelemetryClient({ fetch });

    await expect(client.fetchNodeSummary("5A")).rejects.toThrow("HTTP 503");
  });
});

describe("HttpTelemetryClient.fetchQblocks", () => {
  it("fetches qblock files from the manifest", async () => {
    const calls: string[] = [];
    const client = new HttpTelemetryClient({
      baseUrl: "http://test",
      fetch: (async (url: Parameters<typeof globalThis.fetch>[0]) => {
        const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : "";
        calls.push(u);
        if (u === "http://test/files/qblocks/metadata.json") {
          return new Response(
            JSON.stringify({ qblocks: ["qblocks/ab/cd/2.json", "qblocks/ef/01/1.json"] }),
            { status: 200 },
          );
        }
        // Real writer shape: raw participation plus the winner block.
        const participant = (qblockId: string) => ({
          account: "A",
          kind: "Cpu",
          qblockId,
          blockNumber: "7",
          budgetSeconds: null,
        });
        if (u === "http://test/files/qblocks/ab/cd/2.json") {
          return new Response(
            JSON.stringify({
              qblockId: "2",
              winner: { qblockId: "2", minerId: "5W", timestamp: 1_060 },
              participation: [participant("2")],
            }),
            { status: 200 },
          );
        }
        if (u === "http://test/files/qblocks/ef/01/1.json") {
          return new Response(
            JSON.stringify({
              qblockId: "1",
              winner: { qblockId: "1", minerId: "5W", timestamp: 1_000 },
              participation: [participant("1")],
            }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 404 });
      }) as typeof globalThis.fetch,
    });
    const { rows } = await client.fetchQblocks("/files/qblocks/metadata.json");
    expect(calls).toContain("http://test/files/qblocks/metadata.json");
    expect(rows).toEqual([
      { qblockId: "2", account: "A", kind: "Cpu", miningSeconds: 60, exactQpuAccessUs: null },
    ]);
  });
  it("fetches settled files once and skips files that fail", async () => {
    const calls: string[] = [];
    const paths = Array.from({ length: 40 }, (_, i) => `qblocks/00/00/${i}.json`);
    let inFlight = 0;
    let peak = 0;
    const client = new HttpTelemetryClient({
      baseUrl: "http://test",
      fetch: (async (url: Parameters<typeof globalThis.fetch>[0]) => {
        const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : "";
        calls.push(u);
        if (u.endsWith("/metadata.json")) return json({ qblocks: paths });
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        const id = /\/(\d+)\.json$/.exec(u)?.[1] ?? "";
        if (id === "7") throw new TypeError("network down");
        return json({
          qblockId: id,
          winner: { qblockId: id, minerId: "5W", timestamp: 1_000 + Number(id) * 60 },
          participation: [
            { account: "A", kind: "Cpu", qblockId: id, blockNumber: "1", budgetSeconds: null },
          ],
        });
      }) as typeof globalThis.fetch,
    });
    const { rows: first } = await client.fetchQblocks("/files/qblocks/metadata.json");
    // 39 files load; every file after the first yields an interval (8 measures from 6).
    expect(first).toHaveLength(38);
    expect(peak).toBeLessThanOrEqual(8);
    calls.length = 0;
    await client.fetchQblocks("/files/qblocks/metadata.json");
    // Settled files come from the cache; only the failed file is retried.
    expect(calls).toEqual([
      "http://test/files/qblocks/metadata.json",
      "http://test/files/qblocks/00/00/7.json",
    ]);
  });
  it("loads history days on request and measures across the day boundary", async () => {
    const participant = (qblockId: string) => ({
      account: "A",
      kind: "Cpu",
      qblockId,
      blockNumber: "1",
      budgetSeconds: null,
    });
    const qblock = (id: string, timestamp: number, minerId: string) =>
      json({
        qblockId: id,
        winner: { qblockId: id, timestamp, minerId },
        participation: [participant(id)],
      });
    const client = new HttpTelemetryClient({
      baseUrl: "http://test",
      fetch: (async (url: Parameters<typeof globalThis.fetch>[0]) => {
        const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : "";
        if (u.endsWith("/qblocks/metadata.json")) {
          return json({
            qblocks: ["qblocks/aa/aa/3.json"],
            history: ["qblocks/days/2026-09-03.json"],
          });
        }
        if (u.endsWith("/qblocks/days/2026-09-03.json")) {
          return json({ qblocks: ["qblocks/bb/bb/2.json", "qblocks/cc/cc/1.json"] });
        }
        if (u.endsWith("/3.json")) return qblock("3", 1_300, "5Recent");
        if (u.endsWith("/2.json")) return qblock("2", 1_100, "5Recent");
        if (u.endsWith("/1.json")) return qblock("1", 1_000, "5Old");
        return json({}, 404);
      }) as typeof globalThis.fetch,
    });
    const snapshot = await client.fetchQblocks("/files/qblocks/metadata.json");
    expect(snapshot.rows).toEqual([]);
    expect(snapshot.history).toEqual(["qblocks/days/2026-09-03.json"]);
    expect(snapshot.winners.map((w) => w.qblockId)).toEqual(["3"]);
    const { rows, winners } = await client.fetchQblockHistoryDay("qblocks/days/2026-09-03.json");
    expect(winners.map((w) => w.qblockId).sort()).toEqual(["1", "2", "3"]);
    expect(rows.map((r) => [r.qblockId, r.miningSeconds])).toEqual([
      ["2", 100],
      ["3", 200],
    ]);
    const again = await client.fetchQblocks("/files/qblocks/metadata.json");
    expect(again.history).toEqual([]);
    expect(again.rows).toHaveLength(2);
  });
});

describe("HttpTelemetryClient.fetchMinerCurrentDispatch", () => {
  const DISPATCH_BODY: CurrentDispatch = { solutionNumber: 7, attempts: [], status: "in-flight" };
  const DISPATCH_URL = "/files/miners/5GPP/current-dispatch.json";

  it("requests the baseUrl-prefixed url and returns the parsed document", async () => {
    const { fetch, calls } = fakeFetch(() => json(DISPATCH_BODY));
    const client = new HttpTelemetryClient({ fetch, baseUrl: "https://example.test" });

    const out = await client.fetchMinerCurrentDispatch(DISPATCH_URL);

    expect(calls[0]?.url).toBe(`https://example.test${DISPATCH_URL}`);
    expect(out).toEqual(DISPATCH_BODY);
  });

  it("resolves null on a non-ok response", async () => {
    const { fetch } = fakeFetch(() => new Response("nope", { status: 404 }));
    const client = new HttpTelemetryClient({ fetch });

    const out = await client.fetchMinerCurrentDispatch(DISPATCH_URL);

    expect(out).toBeNull();
  });

  it("rethrows when the signal is aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const fetch = (async (
      _input: Parameters<typeof globalThis.fetch>[0],
      _init?: RequestInit,
    ): Promise<Response> => {
      throw new Error("aborted");
    }) as typeof globalThis.fetch;
    const client = new HttpTelemetryClient({ fetch });

    await expect(client.fetchMinerCurrentDispatch(DISPATCH_URL, ac.signal)).rejects.toThrow(
      "aborted",
    );
  });
});

describe("HttpTelemetryClient.fetchNodesSnapshot", () => {
  const NODES_BODY: NodesDocument = { nodes: null, nodeDescriptors: [] };
  const NODES_URL = "/files/nodes/snapshot.json";

  it("requests the baseUrl-prefixed url and returns the parsed document", async () => {
    const { fetch, calls } = fakeFetch(() => json(NODES_BODY));
    const client = new HttpTelemetryClient({ fetch, baseUrl: "https://example.test" });

    const out = await client.fetchNodesSnapshot(NODES_URL);

    expect(calls[0]?.url).toBe(`https://example.test${NODES_URL}`);
    expect(out).toEqual(NODES_BODY);
  });

  it("resolves null on a non-ok response", async () => {
    const { fetch } = fakeFetch(() => new Response("nope", { status: 404 }));
    const client = new HttpTelemetryClient({ fetch });

    const out = await client.fetchNodesSnapshot(NODES_URL);

    expect(out).toBeNull();
  });

  it("rethrows when the signal is aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const fetch = (async (
      _input: Parameters<typeof globalThis.fetch>[0],
      _init?: RequestInit,
    ): Promise<Response> => {
      throw new Error("aborted");
    }) as typeof globalThis.fetch;
    const client = new HttpTelemetryClient({ fetch });

    await expect(client.fetchNodesSnapshot(NODES_URL, ac.signal)).rejects.toThrow("aborted");
  });
});

describe("HttpTelemetryClient file fetch timeout", () => {
  // A fetch that never resolves on its own. It rejects only when the signal
  // it was handed aborts, which is how a real hung connection behaves once
  // the client gives up on it.
  function hangingFetch(): typeof globalThis.fetch {
    return (async (
      _input: Parameters<typeof globalThis.fetch>[0],
      init?: RequestInit,
    ): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof globalThis.fetch;
  }

  it("resolves the nodes snapshot to null when the timeout elapses", async () => {
    const client = new HttpTelemetryClient({ fetch: hangingFetch(), fileTimeoutMs: 5 });

    const out = await client.fetchNodesSnapshot("/files/nodes/snapshot.json");

    expect(out).toBeNull();
  });

  it("resolves the miner dispatch to null when the timeout elapses", async () => {
    const client = new HttpTelemetryClient({ fetch: hangingFetch(), fileTimeoutMs: 5 });

    const out = await client.fetchMinerCurrentDispatch("/files/miners/5GPP/current-dispatch.json");

    expect(out).toBeNull();
  });

  it("rejects the qblock manifest when the timeout elapses", async () => {
    const client = new HttpTelemetryClient({ fetch: hangingFetch(), fileTimeoutMs: 5 });

    await expect(client.fetchQblocks("/files/qblocks/metadata.json")).rejects.toThrow();
  });

  it("passes a signal on every file request", async () => {
    const manifestUrl = "/files/qblocks/metadata.json";
    const { fetch, calls } = fakeFetch((url) => {
      if (url.endsWith(manifestUrl)) {
        return json({ qblocks: ["qblocks/ab/cd/2.json"] });
      }
      if (url.endsWith("qblocks/ab/cd/2.json")) {
        // Real writer shape: raw participation plus the winner block, same
        // as the fetchQblocks describe block above.
        return json({
          qblockId: "2",
          winner: { qblockId: "2", minerId: "5W", timestamp: 1_060 },
          participation: [
            { account: "A", kind: "Cpu", qblockId: "2", blockNumber: "7", budgetSeconds: null },
          ],
        });
      }
      return json({ solutionNumber: 1, attempts: [], status: "in-flight" });
    });
    const client = new HttpTelemetryClient({ fetch });

    await client.fetchQblocks(manifestUrl);
    await client.fetchMinerCurrentDispatch("/files/miners/5GPP/current-dispatch.json");

    // Three requests land: the manifest, the one qblock file it names (the
    // fetchQblockFile leg, reachable only through fetchQblocks), and the
    // dispatch file. Every one must carry a signal.
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("gives up on the whole qblock walk once the budget elapses", async () => {
    const manifestPaths = Array.from({ length: 80 }, (_, i) => `qblocks/ab/cd/${i}.json`);
    const fetchImpl = ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith("metadata.json")) {
        return Promise.resolve(
          new Response(JSON.stringify({ qblocks: manifestPaths }), { status: 200 }),
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as typeof globalThis.fetch;

    const client = new HttpTelemetryClient({
      fetch: fetchImpl,
      fileTimeoutMs: 50,
      qblockWalkBudgetMs: 120,
    });

    const started = Date.now();
    await client.fetchQblocks("/files/qblocks/metadata.json");
    const elapsed = Date.now() - started;

    // Ten sequential waves of 50ms each would be about 500ms with no budget.
    // The budget stops the walk after about 120ms, plus one in-flight request.
    expect(elapsed).toBeLessThan(300);
  });
});
