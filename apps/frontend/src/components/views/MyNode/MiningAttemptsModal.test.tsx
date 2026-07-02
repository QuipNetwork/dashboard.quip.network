// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { TelemetryClient } from "@/services/telemetry-client";
import { StoryServices } from "@/testing/services";
import type { MiningAttemptsResponse, MiningSubmissionRecord } from "@quip/shared/telemetry";
import { MiningAttemptsModal } from "./MiningAttemptsModal";

function submission(overrides: Partial<MiningSubmissionRecord> = {}): MiningSubmissionRecord {
  return {
    solutionNumber: 7,
    minerId: "5GPP",
    minerType: "CUDA",
    tsNs: "1700000000000000000",
    energyMilli: -15200,
    diversityMilli: 500,
    thresholdMilli: -15300,
    lastProofBlockHash: "0xproof",
    extrinsicHash: null,
    chainBlockHash: null,
    chainBlockNumber: "1042",
    powSequence: null,
    outcome: "submitted_inblock",
    attemptCount: 3,
    bestEnergyMilli: -15200,
    numValid: 1,
    qpuAccessTimeUs: 0,
    observedAt: "2026-05-19T12:00:00Z",
    ...overrides,
  };
}

function clientWith(responder: () => Promise<MiningAttemptsResponse>): TelemetryClient {
  return {
    fetchTelemetry: () => new Promise<never>(() => {}),
    fetchMiningAttempts: () => responder(),
    fetchBlocks: () => new Promise<never>(() => {}),
    fetchNodeLive: () => new Promise<never>(() => {}),
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const flush = () => act(async () => void (await Promise.resolve()));

describe("MiningAttemptsModal", () => {
  it("renders submission detail from the injected client", async () => {
    const client = clientWith(async () => ({ submission: submission(), attempts: [] }));

    await act(async () => {
      root.render(
        <StoryServices client={client}>
          <MiningAttemptsModal solutionNumber={7} onClose={() => {}} />
        </StoryServices>,
      );
    });
    await flush();

    expect(container.textContent).toContain("submitted_inblock");
    expect(container.textContent).toContain("landed at block #1042");
  });

  it("surfaces the client's error message", async () => {
    const client = clientWith(async () => {
      throw new Error("solution #7 not found on miner");
    });

    await act(async () => {
      root.render(
        <StoryServices client={client}>
          <MiningAttemptsModal solutionNumber={7} onClose={() => {}} />
        </StoryServices>,
      );
    });
    await flush();

    expect(container.textContent).toContain("solution #7 not found on miner");
  });
});
