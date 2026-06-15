// SPDX-License-Identifier: AGPL-3.0-or-later

import { selectServerNowMs, useTelemetryStore } from "@/store/telemetry-store";
import { BabeAuthoritiesPanel } from "./BabeAuthoritiesPanel";
import { ValidatorsTable } from "./ValidatorsTable";

/**
 * Active Validators view — the current BABE authority set joined with
 * per-validator authorship counters. Empty state hints at the missing
 * substrate RPC URL, matching the chain-less-mode pattern used elsewhere.
 */
export function ChainView() {
  const validators = useTelemetryStore((s) => s.validators);
  const serverNowMs = useTelemetryStore(selectServerNowMs);

  if (validators.length === 0) {
    return (
      <>
        <div className="border border-border bg-white p-12 text-center">
          <p className="font-heading text-2xl text-ink-strong">No active validators</p>
          <p className="mt-2 font-accent text-sm text-ink-subtle">
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
      <ValidatorsTable validators={validators} serverNowMs={serverNowMs} />
      <BabeAuthoritiesPanel />
    </>
  );
}
