// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import type { NodeDescriptorRecord } from "@/types/telemetry";
import { filterNodeDescriptors } from "./NodeIdentitiesPanel";

function record(accountId: string, nodeName: string): NodeDescriptorRecord {
  return { accountId, descriptor: { nodeName } } as unknown as NodeDescriptorRecord;
}

const DESCRIPTORS = [record("5Alpha", "alpha-rig"), record("5Beta", "beta-rig")];

describe("filterNodeDescriptors", () => {
  it("returns all descriptors for an empty query", () => {
    expect(filterNodeDescriptors(DESCRIPTORS, "")).toHaveLength(2);
  });

  it("matches on account id and node name, case-insensitively", () => {
    expect(filterNodeDescriptors(DESCRIPTORS, "BETA").map((d) => d.accountId)).toEqual(["5Beta"]);
    expect(filterNodeDescriptors(DESCRIPTORS, "5alpha").map((d) => d.accountId)).toEqual([
      "5Alpha",
    ]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterNodeDescriptors(DESCRIPTORS, "zzz")).toHaveLength(0);
  });
});
