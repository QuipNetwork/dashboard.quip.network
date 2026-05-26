// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";
import { AuthError, QuipClient, RateLimitError, type NodeStatus } from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("QuipClient v0.2", () => {
  test("getStatus parses v0.2 envelope and miner identity", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse({
          success: true,
          data: {
            ss58_address: "5GPP",
            account_id_hex: "0xbf",
            node_id: "quip-miner-pow",
            is_mining: true,
            uptime_seconds: 407,
            chain: { head_hash: "0x9a", head_number: 4939 },
            miner_registered: true,
            miner_info: {
              registered_at: 4361,
              deposit: 1000000000000,
              proofs_submitted: 0,
              proofs_won: 0,
              rewards_earned: 0,
            },
            miners: [{ id: "quip-miner-pow-CPU-1", type: "CPU" }],
          },
          timestamp: 1779214930,
        }),
      )) as unknown as typeof fetch;
    const c = new QuipClient({ baseUrl: "http://x", fetchImpl });
    const r: NodeStatus = await c.getStatus();
    expect(r.ss58Address).toBe("5GPP");
    expect(r.nodeId).toBe("quip-miner-pow");
    expect(r.chainHeadNumber).toBe(4939);
    expect(r.minerInfo?.deposit).toBe("1000000000000");
    expect(r.miners).toEqual([{ id: "quip-miner-pow-CPU-1", type: "CPU" }]);
  });

  test("getStatus narrows unknown miner type to OTHER", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse({
          success: true,
          data: {
            ss58_address: "5GPP",
            account_id_hex: "0x",
            node_id: "n",
            is_mining: false,
            uptime_seconds: 0,
            chain: { head_hash: "0x", head_number: 0 },
            miner_registered: false,
            miner_info: null,
            miners: [{ id: "weird-miner", type: "ASIC" }],
          },
        }),
      )) as unknown as typeof fetch;
    const c = new QuipClient({ baseUrl: "http://x", fetchImpl });
    const r = await c.getStatus();
    expect(r.miners[0]?.type).toBe("OTHER");
  });

  test("getStatus tolerates missing miner_info (null)", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse({
          success: true,
          data: {
            ss58_address: "5GPP",
            account_id_hex: "0x",
            node_id: "n",
            is_mining: false,
            uptime_seconds: 0,
            chain: { head_hash: "0x", head_number: 0 },
            miner_registered: false,
            miner_info: null,
            miners: [],
          },
        }),
      )) as unknown as typeof fetch;
    const c = new QuipClient({ baseUrl: "http://x", fetchImpl });
    const r = await c.getStatus();
    expect(r.minerInfo).toBeNull();
  });

  test("getStats reads controller sub-object", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse({
          success: true,
          data: {
            controller: {
              heads_observed: 23,
              contexts_dispatched: 46,
              results_received: 12,
              proofs_submitted: 8,
              stale_drops: 1,
              submission_errors: 2,
            },
          },
        }),
      )) as unknown as typeof fetch;
    const c = new QuipClient({ baseUrl: "http://x", fetchImpl });
    const r = await c.getStats();
    expect(r.headsObserved).toBe(23);
    expect(r.contextsDispatched).toBe(46);
    expect(r.resultsReceived).toBe(12);
    expect(r.proofsSubmitted).toBe(8);
    expect(r.staleDrops).toBe(1);
    expect(r.submissionErrors).toBe(2);
  });

  test("401 raises AuthError", async () => {
    const fetchImpl = (() => Promise.resolve(jsonResponse({}, 401))) as unknown as typeof fetch;
    const c = new QuipClient({ baseUrl: "http://x", fetchImpl });
    await expect(c.getStatus()).rejects.toBeInstanceOf(AuthError);
  });

  test("429 raises RateLimitError", async () => {
    const fetchImpl = (() => Promise.resolve(jsonResponse({}, 429))) as unknown as typeof fetch;
    const c = new QuipClient({ baseUrl: "http://x", fetchImpl });
    await expect(c.getStatus()).rejects.toBeInstanceOf(RateLimitError);
  });

  test("envelope success=false surfaces error message", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse({
          success: false,
          error: "node not ready",
        }),
      )) as unknown as typeof fetch;
    const c = new QuipClient({ baseUrl: "http://x", fetchImpl });
    await expect(c.getStatus()).rejects.toThrow(/node not ready/);
  });

  test("non-OK status raises generic Error with status code", async () => {
    const fetchImpl = (() => Promise.resolve(jsonResponse({}, 502))) as unknown as typeof fetch;
    const c = new QuipClient({ baseUrl: "http://x", fetchImpl });
    await expect(c.getStatus()).rejects.toThrow(/502/);
  });

  test("authorization header is included when token is set", async () => {
    const captured: { auth: string | null } = { auth: null };
    const fetchImpl = ((_url: string, init?: { headers?: Record<string, string> }) => {
      captured.auth = init?.headers?.["authorization"] ?? null;
      return Promise.resolve(
        jsonResponse({
          success: true,
          data: {
            ss58_address: "",
            account_id_hex: "",
            node_id: "",
            is_mining: false,
            uptime_seconds: 0,
            chain: { head_hash: "", head_number: 0 },
            miner_registered: false,
            miner_info: null,
            miners: [],
          },
        }),
      );
    }) as unknown as typeof fetch;
    const c = new QuipClient({ baseUrl: "http://x", token: "secret", fetchImpl });
    await c.getStatus();
    expect(captured.auth).toBe("Bearer secret");
  });

  test("getStatus parses aggregator modes breakdown", async () => {
    // Multi-process container: /api/v1/status carries a `modes` map
    // alongside the aggregate counters. The parser hoists it onto
    // NodeStatus so the dashboard can render per-backend rows.
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse({
          success: true,
          data: {
            ss58_address: "5GPP",
            account_id_hex: "0x",
            node_id: "rig-01",
            is_mining: true,
            uptime_seconds: 100,
            chain: { head_hash: "0x", head_number: 1 },
            miner_registered: true,
            miner_info: null,
            miners: [
              { id: "rig-CPU-1", type: "CPU" },
              { id: "rig-QPU-DWAVE-1", type: "QPU" },
            ],
            modes: {
              cpu: {
                controller: {
                  heads_observed: 50,
                  contexts_dispatched: 50,
                  results_received: 50,
                  proofs_submitted: 3,
                  stale_drops: 1,
                  submission_errors: 0,
                },
                miners: [{ id: "rig-CPU-1", type: "CPU" }],
              },
              qpu: {
                controller: {
                  heads_observed: 50,
                  contexts_dispatched: 50,
                  results_received: 48,
                  proofs_submitted: 2,
                  stale_drops: 0,
                  submission_errors: 2,
                },
                miners: [{ id: "rig-QPU-DWAVE-1", type: "QPU" }],
              },
            },
          },
        }),
      )) as unknown as typeof fetch;
    const c = new QuipClient({ baseUrl: "http://x", fetchImpl });
    const r = await c.getStatus();
    expect(r.modes).toBeDefined();
    expect(Object.keys(r.modes ?? {})).toEqual(["cpu", "qpu"]);
    expect(r.modes?.["cpu"]?.proofsSubmitted).toBe(3);
    expect(r.modes?.["qpu"]?.submissionErrors).toBe(2);
    expect(r.modes?.["cpu"]?.miners).toEqual([{ id: "rig-CPU-1", type: "CPU" }]);
  });

  test("getStatus tolerates missing modes (legacy single-process miner)", async () => {
    // Older miners + single-process containers don't emit `modes`.
    // Parser must return undefined (or empty) without complaint so
    // the rest of NodeStatus is still well-formed.
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse({
          success: true,
          data: {
            ss58_address: "5GPP",
            account_id_hex: "0x",
            node_id: "rig",
            is_mining: true,
            uptime_seconds: 0,
            chain: { head_hash: "0x", head_number: 0 },
            miner_registered: false,
            miner_info: null,
            miners: [],
            // no `modes` key at all
          },
        }),
      )) as unknown as typeof fetch;
    const c = new QuipClient({ baseUrl: "http://x", fetchImpl });
    const r = await c.getStatus();
    expect(r.modes).toEqual({});
  });
});
