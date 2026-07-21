// SPDX-License-Identifier: AGPL-3.0-or-later

import clsx from "clsx";

import { shortAddress } from "@/lib/format-chain";
import type { ValidatorAuthorshipRecord } from "@quip/shared/telemetry";
import { SortableHeaderCell } from "@/components/common/SortableHeaderCell";
import { useValidatorSort } from "./use-validator-sort";

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

export function ValidatorsTable({
  validators,
  serverNowMs,
}: {
  validators: ValidatorAuthorshipRecord[];
  serverNowMs: number;
}) {
  const { sorted, sort, onSort } = useValidatorSort(validators);

  return (
    <div className="border border-border bg-white">
      <header className="border-b border-border px-4 py-3">
        <h2 className="font-heading text-lg text-ink-strong">
          Active Validators ({validators.length})
        </h2>
        <p className="mt-1 font-accent text-xs text-ink-subtle">
          BABE validator set from <code>session.validators</code>. Counters increment per finalized
          head since indexing began (not lifetime — the chain exposes no authored-block counter);
          the PoW column counts heads that also won a <code>quantumPow.BlockWinner</code>.
        </p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full font-accent text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-ink-subtle">
            <tr className="border-b border-border">
              <SortableHeaderCell label="Account" column="account" sort={sort} onClick={onSort} />
              <SortableHeaderCell
                label="Blocks Authored"
                column="blocksAuthored"
                sort={sort}
                onClick={onSort}
                align="right"
              />
              <SortableHeaderCell
                label="With PoW"
                column="blocksAuthoredWithPow"
                sort={sort}
                onClick={onSort}
                align="right"
              />
              <SortableHeaderCell label="Online" column="online" sort={sort} onClick={onSort} />
              <SortableHeaderCell
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
                  className="border-b border-border last:border-b-0 hover:bg-surface-2"
                >
                  <td className="px-4 py-2 font-mono text-xs" title={v.accountId}>
                    {shortAddress(v.accountId)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{v.blocksAuthored}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{v.blocksAuthoredWithPow}</td>
                  <td className="px-4 py-2">
                    {v.online ? (
                      <span className="text-positive">● online</span>
                    ) : (
                      <span className="text-ink-subtle">○ offline</span>
                    )}
                  </td>
                  <td
                    className={clsx("px-4 py-2", last.dim ? "text-ink-subtle" : "text-ink-strong")}
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
  );
}
