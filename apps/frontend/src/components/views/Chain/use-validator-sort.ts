// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ValidatorAuthorshipRecord } from "@quip/shared/telemetry";
import { useTableSort, type SortAccessors } from "@/lib/table-sort";

export type SortColumn =
  | "account"
  | "blocksAuthored"
  | "blocksAuthoredWithPow"
  | "online"
  | "lastAuthored";

const ACCESSORS: SortAccessors<ValidatorAuthorshipRecord, SortColumn> = {
  account: (v) => v.accountId,
  blocksAuthored: (v) => v.blocksAuthored,
  blocksAuthoredWithPow: (v) => v.blocksAuthoredWithPow,
  online: (v) => Number(v.online),
  // Null (never authored) sorts last regardless of direction.
  lastAuthored: (v) => (v.lastAuthoredAt ? Date.parse(v.lastAuthoredAt) : null),
};

export function useValidatorSort(validators: ValidatorAuthorshipRecord[]) {
  return useTableSort(validators, ACCESSORS, { column: "blocksAuthored", direction: "desc" });
}
