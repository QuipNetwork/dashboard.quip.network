// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Generic column sorting for the dashboard's data tables. Each table declares
// one accessor per sortable column mapping a row to a comparable value; the
// hook owns the { column, direction } state and the toggle semantics
// (clicking the active column flips direction, a new column starts desc).
// Pair with `SortableHeaderCell` for the clickable `<th>`s.

import { useMemo, useState } from "react";

export type SortDirection = "asc" | "desc";

export interface SortState<C extends string> {
  column: C;
  direction: SortDirection;
}

// What an accessor may return. `null` means "no value" and sorts last
// regardless of direction — a row missing a descriptor field shouldn't jump
// to the top when the direction flips. BigInt covers u64/u128
// chain counters that arrive as decimal strings.
export type SortValue = string | number | bigint | null;

export type SortAccessors<R, C extends string> = Record<C, (row: R) => SortValue>;

function compare(a: Exclude<SortValue, null>, b: Exclude<SortValue, null>): number {
  if (typeof a === "string" || typeof b === "string") {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  }
  // number | bigint — relational operators compare across the two types.
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortRows<R, C extends string>(
  rows: readonly R[],
  sort: SortState<C>,
  accessors: SortAccessors<R, C>,
): R[] {
  const dir = sort.direction === "asc" ? 1 : -1;
  const accessor = accessors[sort.column];
  const copy = [...rows];
  copy.sort((a, b) => {
    const av = accessor(a);
    const bv = accessor(b);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return dir * compare(av, bv);
  });
  return copy;
}

/**
 * Sort state + sorted rows for a table. `initial: null` leaves the rows in
 * their natural order until the first header click (for tables whose source
 * order is already meaningful).
 */
export function useTableSort<R, C extends string>(
  rows: readonly R[],
  accessors: SortAccessors<R, C>,
  // NoInfer: C must come from the accessors record, not from the initial
  // column's literal — otherwise every other column fails to typecheck.
  initial: NoInfer<SortState<C>> | null,
) {
  const [sort, setSort] = useState<SortState<C> | null>(initial);
  const sorted = useMemo(
    () => (sort ? sortRows(rows, sort, accessors) : [...rows]),
    [rows, sort, accessors],
  );
  const onSort = (column: C) =>
    setSort((prev) =>
      prev?.column === column
        ? { column, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { column, direction: "desc" },
    );
  return { sorted, sort, onSort };
}
