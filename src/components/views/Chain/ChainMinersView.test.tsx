// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useTelemetryStore } from "../../../store/telemetry-store";
import type { BabeAuthorityRecord, ChainMinerRecord } from "../../../types/telemetry";

import { ChainMinersView } from "./ChainMinersView";

const miner = (accountId: string, rewardsEarned: string): ChainMinerRecord => ({
  accountId,
  deposit: "1000000000000",
  proofsSubmitted: "10",
  proofsWon: "3",
  rewardsEarned,
  telemetryNodeAddress: null,
});

const authority = (accountId: string): BabeAuthorityRecord => ({
  accountId,
  displayName: null,
});

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
  useTelemetryStore.setState({
    chainMiners: [],
    babeAuthorities: [],
    recentDifficulty: [],
  });
});

describe("ChainMinersView", () => {
  test("renders empty state when nothing is configured", () => {
    useTelemetryStore.setState({
      chainMiners: [],
      babeAuthorities: [],
      recentDifficulty: [],
    });
    act(() => {
      root.render(createElement(ChainMinersView));
    });
    expect(container.textContent).toContain("QUIP_VALIDATOR_RPC_URL");
  });

  test("renders miner rows with shortened addresses and formatted balances", () => {
    useTelemetryStore.setState({
      chainMiners: [
        miner("5GrwvaEFAbCdEfGhIjKlMnOp1234", "7000000000000"),
        miner("5XyzPqrsTuvW1234567890ABCDef99", "2000000000000"),
      ],
      babeAuthorities: [],
      recentDifficulty: [],
    });
    act(() => {
      root.render(createElement(ChainMinersView));
    });
    // Shortened address head/tail.
    expect(container.textContent).toContain("5Grwva");
    expect(container.textContent).toContain("1234");
    // Balance formatted to QUIP units.
    expect(container.textContent).toContain("7 QUIP");
    expect(container.textContent).toContain("2 QUIP");
  });

  test("renders BabeAuthoritiesPanel inline (closed by default)", () => {
    useTelemetryStore.setState({
      chainMiners: [miner("5M1", "0")],
      babeAuthorities: [authority("5Auth1"), authority("5Auth2")],
      recentDifficulty: [],
    });
    act(() => {
      root.render(createElement(ChainMinersView));
    });
    // The details summary is visible; full list is collapsed but still in DOM.
    expect(container.textContent).toContain("BABE Authorities (2)");
    expect(container.querySelector("details")).not.toBeNull();
  });

  test("DifficultyChart hides when fewer than 2 snapshots", () => {
    useTelemetryStore.setState({
      chainMiners: [miner("5M1", "0")],
      babeAuthorities: [],
      recentDifficulty: [
        {
          observedAtBlock: "100",
          difficultyEnergy: 12.5,
          minDiversity: 0.5,
          minSolutions: 3,
          minQuality: 0.25,
          observedAt: "2026-05-15T00:00:00Z",
        },
      ],
    });
    act(() => {
      root.render(createElement(ChainMinersView));
    });
    expect(container.querySelector('[data-qa="chart-difficulty-history"]')).toBeNull();
  });

  test("shows on-chain miner count in the section header", () => {
    useTelemetryStore.setState({
      chainMiners: [miner("5M1", "0"), miner("5M2", "0"), miner("5M3", "0")],
      babeAuthorities: [],
      recentDifficulty: [],
    });
    act(() => {
      root.render(createElement(ChainMinersView));
    });
    expect(container.textContent).toContain("On-chain miners (3)");
  });
});
