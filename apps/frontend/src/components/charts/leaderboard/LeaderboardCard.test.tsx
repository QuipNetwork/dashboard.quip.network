// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { StoryServices, idleTelemetryClient } from "@/testing/services";
import type { ChainMinerRecord } from "@quip/shared/telemetry";

import { LeaderboardCard } from "./LeaderboardCard";

function makeChainMiner(accountId: string, proofsWon: string): ChainMinerRecord {
  return {
    accountId,
    deposit: "0",
    proofsSubmitted: proofsWon,
    proofsWon,
    rewardsEarned: "0",
    telemetryNodeAddress: null,
    hardware: null,
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

describe("LeaderboardCard", () => {
  it("renders the title and the By Count | By Energy | By Time toggle", () => {
    act(() =>
      root.render(
        <StoryServices
          client={idleTelemetryClient}
          telemetry={{ chainMiners: [makeChainMiner("5A", "3")] }}
        >
          <LeaderboardCard />
        </StoryServices>,
      ),
    );

    expect(container.textContent).toContain("Mining Leaderboard");
    const buttons = Array.from(
      container.querySelectorAll('[role="group"][aria-label="Leaderboard mode"] button'),
    ).map((b) => b.textContent);
    expect(buttons).toEqual(["By Count", "By Energy", "By Time"]);
  });
});
