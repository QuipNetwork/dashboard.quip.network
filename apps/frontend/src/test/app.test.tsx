// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import type { BlockRecord, TelemetryResponse } from "@quip/shared/telemetry";
import { ServicesProvider } from "@/services/services-provider";
import { useTelemetryStore } from "@/store/telemetry-store";
import { useUIStore } from "@/store/ui-store";
import { waitFor } from "@/test/wait-for-act";

function makeBlock(overrides: Partial<BlockRecord> & Pick<BlockRecord, "minerId">): BlockRecord {
  const n = overrides.substrateBlockNumber ?? "0";
  return {
    blockHash: `hash-${n}`,
    substrateBlockNumber: n,
    substrateBlockHash: `sub-hash-${n}`,
    substrateParentHash: `sub-parent-${n}`,
    timestamp: 1700000000 + Number(n) * 60,
    energy: 0.5,
    diversity: 0.3,
    numValidSolutions: 1,
    miningTime: 12,
    reward: "1000000000000",
    qblockId: "1",
    nonce: "42",
    numNodes: 100,
    numEdges: 200,
    difficultyEnergy: 0.4,
    minDiversity: 0.2,
    minSolutions: 1,
    topologyHash: null,
    finalized: false,
    deviceAccessTimeUs: null,
    ...overrides,
  };
}

// One in-window win so the mining-time card renders its chart (an empty
// window shows the "No qblocks in this range yet" notice instead). With no
// chainMiners the miner resolves to "OTHER", which selectedTypes includes.
const MOCK_MINING_HISTORY = {
  since: "1970-01-01T00:00:00.000Z",
  rows: [
    {
      qblockId: "1",
      substrateBlockNumber: "5",
      timestamp: 1700000300,
      minerId: "qpu-miner-1",
      miningTime: 12,
    },
  ],
};

const MOCK_RESPONSE: TelemetryResponse = {
  selfAddress: null,
  indexer: null,
  serverTime: "2025-01-01T00:00:00Z",
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
  capabilities: { minerDispatch: true },
  // The participation facts now ride in the file-backed qblock tree, served
  // under /files (see the /files route in the fetch mock below). They are no
  // longer part of the telemetry response.
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  useTelemetryStore.setState({
    wonBlocks: [],
    selfAddress: null,
    indexer: null,
    serverTime: null,
    chainHead: null,
    babeEpoch: null,
    babeAuthorities: [],
    chainMiners: [],
    recentDifficulty: [],
    loading: true,
    error: null,
  });
  // Smoke test asserts against the Compute view's chart grid (the mining
  // analytics moved there — docs/ui-layout.md); the default viewMode is
  // "my-node" which doesn't render those charts. With the v0.3 transitional
  // category model, blocks with no chain-miner row resolve to "OTHER" —
  // include it in selectedTypes so the byType-keyed charts have data to
  // render in the absence of per-miner hardware.
  useUIStore.setState({
    viewMode: "compute",
    selectedTypes: ["CPU", "GPU", "QPU", "OTHER"],
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("App smoke test", () => {
  test("renders the compute view's chart grid after fetching telemetry", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input: unknown) => {
      // Route by URL: the app fetches /api/miner-wins and /api/mining-history
      // alongside /api/telemetry, and each expects its own response shape.
      const url = String(input);
      // The store fetches the qblock manifest and qblock files under /files
      // after the slimmed telemetry response (see fetchQblocks). Route those
      // to file-shaped fixtures so the participation-driven charts render.
      if (url.endsWith("/files/qblocks/metadata.json")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ qblocks: ["qblocks/ab/cd/1.json", "qblocks/ef/01/0.json"] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      // Indexer file shape: raw participation plus the winner block. The
      // client derives miningSeconds from consecutive winner timestamps, so
      // qblock 0 only anchors the 12-second window of qblock 1.
      const qblockMatch = /\/files\/qblocks\/.*\/(\d+)\.json$/.exec(url);
      if (qblockMatch) {
        const qblockId = qblockMatch[1];
        const participant = (account: string, kind: string) => ({
          qblockId,
          account,
          kind,
          blockNumber: "1",
          budgetSeconds: null,
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              qblockId,
              winner: makeBlock({
                qblockId,
                substrateBlockNumber: qblockId,
                minerId: "qpu-miner-1",
                timestamp: qblockId === "0" ? 988 : 1_000,
              }),
              participation: [
                participant("cpu-miner-1", "Cpu"),
                participant("gpu-miner-1", "Gpu"),
                participant("qpu-miner-1", "QpuDwave"),
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      const body = url.endsWith("/api/miner-wins")
        ? { rows: [] }
        : url.includes("/api/mining-history")
          ? MOCK_MINING_HISTORY
          : MOCK_RESPONSE;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch);

    const App = (await import("@/App")).default;

    await act(async () => {
      root.render(createElement(ServicesProvider, null, createElement(App)));
    });
    // Flush the fetchTelemetry microtask so the loading flag flips and the
    // network view actually mounts.
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => container.querySelector('[data-qa="chart-blocks-over-time"]') !== null);

    expect(fetchSpy).toHaveBeenCalledWith("/api/telemetry");
    expect(container.querySelector('[data-qa="chart-blocks-over-time"]')).not.toBeNull();
    expect(container.querySelector('[data-qa="chart-mining-time"]')).not.toBeNull();
    // Total Compute Used (chart-compute-used) and Mining Nodes by Type
    // (chart-active-nodes) moved to the Network tab (bead 1o0.1), so they are
    // no longer part of the Compute view's grid.

    fetchSpy.mockRestore();
  });
});
