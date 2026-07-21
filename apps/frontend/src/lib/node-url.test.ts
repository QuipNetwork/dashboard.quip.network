// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import { nodeSearch, parseNodeParam } from "./node-url";

describe("parseNodeParam", () => {
  test("extracts the node account id", () => {
    expect(parseNodeParam("?node=5GrwvaEF")).toBe("5GrwvaEF");
  });

  test("null when the param is absent or empty", () => {
    expect(parseNodeParam("")).toBeNull();
    expect(parseNodeParam("?view=network")).toBeNull();
    expect(parseNodeParam("?node=")).toBeNull();
    expect(parseNodeParam("?node=%20%20")).toBeNull();
  });

  test("round-trips a value with URL-significant characters", () => {
    const id = "5Grwva EF+/=";
    expect(parseNodeParam(nodeSearch(id))).toBe(id);
  });
});

describe("nodeSearch", () => {
  test("builds ?node=<encoded> for a selection", () => {
    expect(nodeSearch("5GrwvaEF")).toBe("?node=5GrwvaEF");
  });

  test("empty string when nothing is selected", () => {
    expect(nodeSearch(null)).toBe("");
  });
});
