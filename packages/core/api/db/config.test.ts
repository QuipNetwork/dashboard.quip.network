// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { getConfigFromEnv } from "./index";

const saved: Record<string, string | undefined> = {};
const KEYS = ["DATABASE_URL", "DATABASE_POOL_MAX"] as const;

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
  delete process.env.DATABASE_POOL_MAX;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("getConfigFromEnv", () => {
  it("omits poolMax when DATABASE_POOL_MAX is unset (adapter default applies)", () => {
    expect(getConfigFromEnv()).toEqual({ databaseUrl: "postgres://u:p@h:5432/db" });
  });

  it("reads a valid DATABASE_POOL_MAX", () => {
    process.env.DATABASE_POOL_MAX = "20";
    expect(getConfigFromEnv().poolMax).toBe(20);
  });

  it("ignores malformed or non-positive DATABASE_POOL_MAX", () => {
    for (const bad of ["0", "-5", "abc", ""]) {
      process.env.DATABASE_POOL_MAX = bad;
      expect(getConfigFromEnv().poolMax).toBeUndefined();
    }
  });

  it("throws when DATABASE_URL is missing", () => {
    delete process.env.DATABASE_URL;
    expect(() => getConfigFromEnv()).toThrow(/DATABASE_URL/);
  });
});
