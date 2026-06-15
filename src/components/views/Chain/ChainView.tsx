// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";

import { shortAddress } from "@/lib/format-chain";
import { selectServerNowMs, useTelemetryStore } from "@/store/telemetry-store";
import type { ValidatorAuthorshipRecord } from "@/types/telemetry";
import { BabeAuthoritiesPanel } from "./BabeAuthoritiesPanel";

// Sortable column identifiers. Tied to the visible columns on the table.
type SortColumn =
  | "account"
  | "blocksAuthored"
  | "blocksAuthoredWithPow"
  | "online"
  | "lastAuthored";
type SortDirection = "asc" | "desc";

interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

// Format `lastAuthoredAt` as "Xs ago · #block". `null` (validator has not
// authored anything the indexer has seen) renders as an em dash.
function formatLastAuthored(
  v: ValidatorAuthorshipRecord,
  serverNowMs: number,
): { text: string; dim: boolean } {
  if (v.lastAuthoredAt === null || v.lastAuthoredBlock === null) {
    return { text: "—", dim: true };
  }
  const ageSec = Math.max(0, Math.floor((serverNowMs - Date.parse(v.lastAuthoredAt)) / 1000));
  const ageLabel = ageSec < 60 ? `${ageSec}s ago` : `${Math.floor(ageSec / 60)}m ago`;
  return { text: `${ageLabel} · #${v.lastAuthoredBlock}`, dim: false };
}

// Sort comparator. Returns a copy because state.validators is shared with
// other components in the store; mutating in place would defeat zustand
// reference equality.
function sortValidators(
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
        // Online (true) outranks offline (false) on ASC; flip for DESC.
        return dir * (Number(a.online) - Number(b.online));
      case "lastAuthored": {
        // Nulls sort last regardless of direction so unoccupied rows don't
        // float to the top when toggling DESC. Compare epoch ms otherwise.
        const aMs = a.lastAuthoredAt ? Date.parse(a.lastAuthoredAt) : -Infinity;
        const bMs = b.lastAuthoredAt ? Date.parse(b.lastAuthoredAt) : -Infinity;
        return dir * (aMs - bMs);
      }
    }
  });
  return copy;
}

interface HeaderCellProps {
  label: string;
  column: SortColumn;
  sort: SortState;
  onClick: (column: SortColumn) => void;
  align?: "left" | "right";
}

function HeaderCell({ label, column, sort, onClick, align = "left" }: HeaderCellProps) {
  const active = sort.column === column;
  const indicator = active ? (sort.direction === "asc" ? " ▲" : " ▼") : "";
  return (
    <th
      className={`cursor-pointer px-4 py-2 select-none hover:text-brand-gray-5 ${
        align === "right" ? "text-right" : ""
      } ${active ? "text-brand-gray-5" : ""}`}
      onClick={() => onClick(column)}
    >
      {label}
      {indicator}
    </th>
  );
}

/**
 * Active Validators view — replaces the legacy `ChainMinersView` on the
 * Chain tab. Renders the current BABE authority set (sourced from
 * `session.validators` and observed by the substrate worker) joined with
 * per-validator authorship counters (sourced from `validator_authorship`).
 *
 * The table is sortable on every column. Defaults to DESC by Blocks
 * Authored — the most active validators surface first.
 *
 * Empty state: when no BABE authorities are loaded, hint at the missing
 * substrate RPC URL. This matches the chain-less-mode pattern the rest
 * of the dashboard uses.
 */
export function ChainView() {
  const validators = useTelemetryStore((s) => s.validators);
  const serverNowMs = useTelemetryStore(selectServerNowMs);
  const [sort, setSort] = useState<SortState>({
    column: "blocksAuthored",
    direction: "desc",
  });

  const sorted = useMemo(() => sortValidators(validators, sort), [validators, sort]);

  const onSort = (column: SortColumn) => {
    setSort((prev) =>
      prev.column === column
        ? { column, direction: prev.direction === "asc" ? "desc" : "asc" }
        : // First click on a new column: default to DESC so highest-value
          // rows land at the top regardless of the previous column.
          { column, direction: "desc" },
    );
  };

  if (validators.length === 0) {
    return (
      <>
        <div className="rounded-xl border border-brand-gray-2 bg-brand-gray-1/40 p-12 text-center backdrop-blur-xl">
          <p className="font-heading text-2xl text-brand-gray-5">No active validators</p>
          <p className="mt-2 font-accent text-sm text-brand-gray-3">
            Set <code>QUIP_VALIDATOR_RPC_URLS</code> on the indexer to surface the BABE authority
            set and per-validator authorship stats here.
          </p>
        </div>
        <BabeAuthoritiesPanel />
      </>
    );
  }

  return (
    <>
      <div className="rounded-xl border border-brand-gray-2 bg-brand-gray-1/40 backdrop-blur-xl">
        <header className="border-b border-brand-gray-2 px-4 py-3">
          <h2 className="font-heading text-lg text-brand-gray-5">
            Active Validators ({validators.length})
          </h2>
          <p className="mt-1 font-accent text-xs text-brand-gray-3">
            BABE validator set from <code>session.validators</code>. Counters increment per
            finalized head; the PoW column counts heads that also won a{" "}
            <code>quantumPow.BlockWinner</code>.
          </p>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full font-accent text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-brand-gray-3">
              <tr className="border-b border-brand-gray-2">
                <HeaderCell label="Account" column="account" sort={sort} onClick={onSort} />
                <HeaderCell
                  label="Blocks Authored"
                  column="blocksAuthored"
                  sort={sort}
                  onClick={onSort}
                  align="right"
                />
                <HeaderCell
                  label="With PoW"
                  column="blocksAuthoredWithPow"
                  sort={sort}
                  onClick={onSort}
                  align="right"
                />
                <HeaderCell label="Online" column="online" sort={sort} onClick={onSort} />
                <HeaderCell
                  label="Last Authored"
                  column="lastAuthored"
                  sort={sort}
                  onClick={onSort}
                />
              </tr>
            </thead>
            <tbody>
              {sorted.map((v) => {
                const last = formatLastAuthored(v, serverNowMs);
                return (
                  <tr
                    key={v.accountId}
                    className="border-b border-brand-gray-1 last:border-b-0 hover:bg-brand-gray-2/30"
                  >
                    <td className="px-4 py-2 font-mono text-xs" title={v.accountId}>
                      {shortAddress(v.accountId)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{v.blocksAuthored}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{v.blocksAuthoredWithPow}</td>
                    <td className="px-4 py-2">
                      {v.online ? (
                        <span className="text-brand-green-0">● online</span>
                      ) : (
                        <span className="text-brand-gray-3">○ offline</span>
                      )}
                    </td>
                    <td
                      className={`px-4 py-2 ${last.dim ? "text-brand-gray-3" : "text-brand-gray-5"}`}
                    >
                      {last.text}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <BabeAuthoritiesPanel />
    </>
  );
}
