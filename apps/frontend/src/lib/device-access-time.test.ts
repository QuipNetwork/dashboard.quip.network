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
});
