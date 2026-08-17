// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Conformance test C4 of the quip-miner v0.3 REST contract.
//
// `fixtures/dashboard_rest_golden.json` is a vendored copy of
// `conformance/dashboard_rest_golden.json` in the quip-miner repo, written by
// the coordinator's own golden test. It holds the exact response bodies the
// v0.3 coordinator serves for the three endpoints, across four fixtures:
// a normal result set, an all-sentinel set, a set with a u64::MAX device time,
// and a submitted proof carrying the real chain fields.
//
// Re-copy the file whenever quip-miner regenerates it. A drift between the two
// copies is a contract change, and this test is where it must surface.

import { describe, expect, test } from "bun:test";

import golden from "./fixtures/dashboard_rest_golden.json";
import { QuipClient } from "./miner-client";

type GoldenKey = keyof typeof golden;

/** Serve one golden body for every request, so one client call is one fixture. */
function clientFor(body: unknown): QuipClient {
  const fetchImpl = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as unknown as typeof fetch;
  return new QuipClient({ baseUrl: "http://miner.test", fetchImpl });
}

/**
 * Every number the parsers produce lands in a PostgreSQL BIGINT or INTEGER
 * column, or is compared against one. A value outside the IEEE-754 safe
 * integer range has already lost precision by the time we see it, so assert
 * on the whole parsed tree rather than field by field.
 */
function expectAllSafeIntegers(value: unknown, path: string): void {
  if (typeof value === "number") {
    // Label the assertion with the path so a failure names the field.
    expect({ path, safe: Number.isSafeInteger(value) }).toEqual({ path, safe: true });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => expectAllSafeIntegers(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) expectAllSafeIntegers(v, `${path}.${k}`);
  }
}

const FIXTURES = ["normal", "all_sentinel", "huge_device_time", "submitted"] as const;

describe("quip-miner REST golden bodies — safe-integer sweep", () => {
  for (const fixture of FIXTURES) {
    test(`${fixture}: /api/v1/mining/attempts parses within the safe range`, async () => {
      const body = golden[`${fixture}/mining_attempts` as GoldenKey];
      const parsed = await clientFor(body).getMiningAttempts(1);
      expectAllSafeIntegers(parsed, `${fixture}.attempts`);
    });

    test(`${fixture}: /api/v1/status parses within the safe range`, async () => {
      const body = golden[`${fixture}/status` as GoldenKey];
      const parsed = await clientFor(body).getStatus();
      expectAllSafeIntegers(parsed, `${fixture}.status`);
    });

    test(`${fixture}: /api/v1/stats parses within the safe range`, async () => {
      const body = golden[`${fixture}/stats` as GoldenKey];
      const parsed = await clientFor(body).getStats();
      expectAllSafeIntegers(parsed, `${fixture}.stats`);
    });
  }
});

describe("quip-miner REST golden bodies — contract values", () => {
  test("all_sentinel: no i64::MAX reaches energyMilli or bestEnergyMilli", async () => {
    // Attempt 1 carries raw_best_energy_milli=-500 behind an i64::MAX gate
    // value; attempt 2 is the legacy shape with no raw field, so it resolves
    // to 0. The submission picks the last record, hence 0.
    const parsed = await clientFor(golden["all_sentinel/mining_attempts"]).getMiningAttempts(2);
    expect(parsed.submission.energyMilli).toBe(0);
    expect(parsed.attempts.map((a) => a.bestEnergyMilli)).toEqual([-500, 0]);
    expect(parsed.submission.bestEnergyMilli).toBe(-500);
  });

  test("huge_device_time: the coordinator guard clamps u64::MAX device time", async () => {
    const parsed = await clientFor(golden["huge_device_time/mining_attempts"]).getMiningAttempts(3);
    expect(parsed.submission.qpuAccessTimeUs).toBe(0);
  });

  test("submitted: the real chain fields survive the parse", async () => {
    const parsed = await clientFor(golden["submitted/mining_attempts"]).getMiningAttempts(4);
    const s = parsed.submission;
    expect(s.outcome).toBe("submitted");
    expect(s.minerType).toBe("CPU");
    expect(s.thresholdMilli).toBe(-2500000);
    expect(s.lastProofBlockHash).toBe(`0x${"11".repeat(32)}`);
    expect(s.extrinsicHash).toBe(`0x${"22".repeat(32)}`);
    expect(s.chainBlockHash).toBe(`0x${"33".repeat(32)}`);
    expect(s.chainBlockNumber).toBe("10249");
    expect(s.powSequence).toBe(412);
  });

  test("normal: status carries a live identity, miners, and modes", async () => {
    const status = await clientFor(golden["normal/status"]).getStatus();
    expect(status.ss58Address.length).toBeGreaterThan(0);
    expect(status.miners[0]?.type).toBe("CPU");
    expect(status.chainHeadNumber).toBe(10249);
    expect(status.minerInfo?.proofsSubmitted).toBe("412");
    expect(Object.keys(status.modes ?? {})).toEqual(["cpu"]);
  });
});
