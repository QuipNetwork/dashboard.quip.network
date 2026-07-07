// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import {
  QPU_ESTIMATED_ACCESS_SECONDS_PER_WIN,
  resolveDeviceAccessTime,
} from "@/lib/device-access-time";

describe("resolveDeviceAccessTime", () => {
  test("a reported value wins, converted µs → s", () => {
    const r = resolveDeviceAccessTime({ deviceAccessTimeUs: 45_500_000, miningTime: 999 }, "QPU");
    expect(r).toEqual({ seconds: 45.5, estimated: false });
  });

  test("null + CPU falls back to miningTime, estimated", () => {
    const r = resolveDeviceAccessTime({ deviceAccessTimeUs: null, miningTime: 12 }, "CPU");
    expect(r).toEqual({ seconds: 12, estimated: true });
  });

  test("null + GPU falls back to miningTime, estimated", () => {
    const r = resolveDeviceAccessTime({ deviceAccessTimeUs: null, miningTime: 8 }, "GPU");
    expect(r).toEqual({ seconds: 8, estimated: true });
  });

  test("null + OTHER falls back to miningTime, estimated", () => {
    const r = resolveDeviceAccessTime({ deviceAccessTimeUs: null, miningTime: 30 }, "OTHER");
    expect(r).toEqual({ seconds: 30, estimated: true });
  });

  test("null + QPU falls back to the documented constant, estimated", () => {
    const r = resolveDeviceAccessTime({ deviceAccessTimeUs: null, miningTime: 999 }, "QPU");
    expect(r).toEqual({ seconds: QPU_ESTIMATED_ACCESS_SECONDS_PER_WIN, estimated: true });
  });

  test("0 is treated as missing (present but unreported), not a real 0s report", () => {
    const r = resolveDeviceAccessTime({ deviceAccessTimeUs: 0, miningTime: 5 }, "CPU");
    expect(r).toEqual({ seconds: 5, estimated: true });
  });

  test("negative value is treated as missing", () => {
    const r = resolveDeviceAccessTime({ deviceAccessTimeUs: -1, miningTime: 5 }, "GPU");
    expect(r).toEqual({ seconds: 5, estimated: true });
  });

  test("NaN is treated as missing", () => {
    const r = resolveDeviceAccessTime({ deviceAccessTimeUs: NaN, miningTime: 5 }, "QPU");
    expect(r).toEqual({ seconds: QPU_ESTIMATED_ACCESS_SECONDS_PER_WIN, estimated: true });
  });

  // Regression guard for the "QPU time is implausible" report: the constant
  // is derived from h0_gpu_vs_qpu_phaseB's pooled r=112 arms as
  // mean(qpu_access_us) / 1e6 = 62066.0152 µs → 0.0620660152 s (see the
  // module-level comment for the full derivation). Verified directly
  // against the source scores (qpu_access_us ranges ~59065-65815 across the
  // three pooled arms, mean ~62066) and comparative_frontier.json's
  // params.qpu_access_s === 0.0620660152 — the constant is correct in both
  // value and units (seconds, not ms/µs). This pins the plausible order of
  // magnitude so a future µs/s or ms/s conversion slip is caught.
  test("QPU estimate is on the order of tens of milliseconds, not micro- or full seconds", () => {
    expect(QPU_ESTIMATED_ACCESS_SECONDS_PER_WIN).toBeGreaterThan(0.01);
    expect(QPU_ESTIMATED_ACCESS_SECONDS_PER_WIN).toBeLessThan(1);
    expect(QPU_ESTIMATED_ACCESS_SECONDS_PER_WIN).toBeCloseTo(0.0620660152, 9);
  });

  test("QPU estimate seconds match the documented raw µs figure divided by 1e6", () => {
    const rawMeanUs = 62066.0152;
    const r = resolveDeviceAccessTime({ deviceAccessTimeUs: null, miningTime: 999 }, "QPU");
    expect(r.seconds).toBeCloseTo(rawMeanUs / 1_000_000, 9);
  });
});
