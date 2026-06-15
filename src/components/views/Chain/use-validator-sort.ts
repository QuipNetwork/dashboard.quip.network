// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";

import type { ValidatorAuthorshipRecord } from "@/types/telemetry";

export type SortColumn =
  | "account"
  | "blocksAuthored"
  | "blocksAuthoredWithPow"
  | "online"
  | "lastAuthored";
export type SortDirection = "asc" | "desc";

export interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

export function sortValidators(
  rows: ValidatorAuthorshipRecord[],
  sort: SortState,
): ValidatorAuthorshipRecord[] {
  const dir = sort.direction === "asc" ? 1 : -1;
  const copy = [...rows];
  copy.sort((a, b) => {
    switch (sort.column) {
      case "account":
        return dir * a.accountId.localeCompare(b.accountId);
      case "blocksAuthored":
        return dir * (a.blocksAuthored - b.blocksAuthored);
      case "blocksAuthoredWithPow":
        return dir * (a.blocksAuthoredWithPow - b.blocksAuthoredWithPow);
      case "online":
        return dir * (Number(a.online) - Number(b.online));
      case "lastAuthored": {
        // Nulls sort last regardless of direction.
        const aMs = a.lastAuthoredAt ? Date.parse(a.lastAuthoredAt) : -Infinity;
        const bMs = b.lastAuthoredAt ? Date.parse(b.lastAuthoredAt) : -Infinity;
        return dir * (aMs - bMs);
      }
    }
  });
  return copy;
}

export function useValidatorSort(validators: ValidatorAuthorshipRecord[]) {
  const [sort, setSort] = useState<SortState>({ column: "blocksAuthored", direction: "desc" });
  const sorted = useMemo(() => sortValidators(validators, sort), [validators, sort]);
  const onSort = (column: SortColumn) =>
    setSort((prev) =>
      prev.column === column
        ? { column, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { column, direction: "desc" },
    );
  return { sorted, sort, onSort };
}
