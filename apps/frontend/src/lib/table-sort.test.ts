// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";

import { sortRows, type SortAccessors } from "./table-sort";

interface Row {
  id: string;
  count: number;
  amount: string; // u128-as-string
  name: string | null;
}

type Col = "count" | "amount" | "name";

const ACCESSORS: SortAccessors<Row, Col> = {
  count: (r) => r.count,
  amount: (r) => BigInt(r.amount),
  name: (r) => r.name,
};

const ROWS: Row[] = [
  { id: "a", count: 2, amount: "18446744073709551616", name: "Zeta" },
  { id: "b", count: 1, amount: "9", name: null },
  { id: "c", count: 3, amount: "36893488147419103232", name: "alpha" },
];

function ids(rows: Row[]): string[] {
  return rows.map((r) => r.id);
}

describe("sortRows", () => {
  it("sorts numbers in both directions", () => {
    expect(ids(sortRows(ROWS, { column: "count", direction: "asc" }, ACCESSORS))).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(ids(sortRows(ROWS, { column: "count", direction: "desc" }, ACCESSORS))).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("sorts bigints numerically past Number.MAX_SAFE_INTEGER", () => {
    expect(ids(sortRows(ROWS, { column: "amount", direction: "desc" }, ACCESSORS))).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("sorts strings case-insensitively with nulls last in both directions", () => {
    expect(ids(sortRows(ROWS, { column: "name", direction: "asc" }, ACCESSORS))).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(ids(sortRows(ROWS, { column: "name", direction: "desc" }, ACCESSORS))).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("compares numeric fragments in strings numerically", () => {
    const rows: Row[] = [
      { id: "v10", count: 0, amount: "0", name: "0.10.0" },
      { id: "v2", count: 0, amount: "0", name: "0.2.0" },
    ];
    expect(ids(sortRows(rows, { column: "name", direction: "asc" }, ACCESSORS))).toEqual([
      "v2",
      "v10",
    ]);
  });

  it("does not mutate the input", () => {
    const input = [...ROWS];
    sortRows(input, { column: "count", direction: "asc" }, ACCESSORS);
    expect(ids(input)).toEqual(["a", "b", "c"]);
  });
});
