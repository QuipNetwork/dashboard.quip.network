// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type { TelemetryResponse } from "./telemetry";

// Every top-level key the TypeScript wire type declares. The `satisfies`
// clause rejects a name that is not a key of TelemetryResponse; the
// MissingKeys assignment below rejects a key of TelemetryResponse that is
// missing from this list. Together they keep the list honest at typecheck
// time, so the runtime check below only has to compare it against the JSON.
const TELEMETRY_KEYS = [
  "selfAddress",
  "indexer",
  "serverTime",
  "chainHead",
  "babeEpoch",
  "babeAuthorities",
  "chainMiners",
  "recentDifficulty",
  "mineableTopologies",
  "validators",
  "recentMiningSubmissions",
  "selfProblemsAttempted",
  "files",
] as const satisfies readonly (keyof TelemetryResponse)[];

const FILES_KEYS = [
  "qblocksManifest",
  "nodesSnapshot",
  "minerCurrentDispatch",
] as const satisfies readonly (keyof TelemetryResponse["files"])[];

// A TelemetryResponse key absent from TELEMETRY_KEYS makes MissingKeys
// something other than never, and this assignment stops compiling.
type MissingKeys = Exclude<keyof TelemetryResponse, (typeof TELEMETRY_KEYS)[number]>;
const allTopLevelKeysListed: MissingKeys extends never ? true : never = true;

type MissingFilesKeys = Exclude<keyof TelemetryResponse["files"], (typeof FILES_KEYS)[number]>;
const allFilesKeysListed: MissingFilesKeys extends never ? true : never = true;

// These two `it` blocks look tautological — each body is just
// `expect(...).toBe(true)`. The real assertion is the conditional-type
// annotation on each const above (`MissingKeys extends never ? true : never`),
// which fails typecheck if a key goes missing from the list. tsconfig.base.json
// sets `noUnusedLocals: true`, so deleting these `it` blocks would leave both
// consts unused and fail the build with TS6133 — the `expect` calls are what
// keep the compile-time guard alive.
describe("TELEMETRY_KEYS and FILES_KEYS stay exhaustive at compile time", () => {
  it("lists every top-level TelemetryResponse key", () => {
    expect(allTopLevelKeysListed).toBe(true);
  });

  it('lists every TelemetryResponse["files"] key', () => {
    expect(allFilesKeysListed).toBe(true);
  });
});

// Keys present in the JSON that the TypeScript type does not declare. An
// empty result means the fixture cannot carry a field the frontend is blind
// to.
function undeclaredKeys(value: unknown, declared: readonly string[]): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.keys(value as Record<string, unknown>).filter((key) => !declared.includes(key));
}

const FIXTURES = ["telemetry-empty.json", "telemetry-populated.json"] as const;

async function loadFixture(name: string): Promise<Record<string, unknown>> {
  const url = new URL(`../../crates/quip-dashboard/tests/fixtures/api/${name}`, import.meta.url);
  return (await Bun.file(url).json()) as Record<string, unknown>;
}

describe("undeclaredKeys", () => {
  it("names a key the type does not declare", () => {
    expect(undeclaredKeys({ selfAddress: null, minerHashRate: 5 }, TELEMETRY_KEYS)).toEqual([
      "minerHashRate",
    ]);
  });

  it("is empty when every key is declared", () => {
    expect(undeclaredKeys({ selfAddress: null, files: {} }, TELEMETRY_KEYS)).toEqual([]);
  });
});

describe("the Rust golden fixtures against the TypeScript wire type", () => {
  for (const name of FIXTURES) {
    it(`${name} carries no key TelemetryResponse is missing`, async () => {
      const fixture = await loadFixture(name);
      expect(undeclaredKeys(fixture, TELEMETRY_KEYS)).toEqual([]);
    });

    it(`${name} files object carries no key TelemetryResponse["files"] is missing`, async () => {
      const fixture = await loadFixture(name);
      expect(undeclaredKeys(fixture.files, FILES_KEYS)).toEqual([]);
    });
  }
});
