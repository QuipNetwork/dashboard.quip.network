// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTelemetryStore } from "@/store/telemetry-store";

/**
 * Compact list of BABE authorities (the account IDs the chain has
 * authorized to author blocks in the current epoch). Renders inside a
 * `<details>` because the data is thin on quip-protocol-rs spec 101 — no
 * identity pallet means we only have account IDs, no display names, no
 * commission/stake metrics. Operators who care about the active set can
 * expand the disclosure; the rest of the dashboard's mining audience can
 * ignore it.
 *
 * Hides itself when the authorities list is empty (substrate worker not
 * configured or first poll hasn't completed).
 */
export function BabeAuthoritiesPanel() {
  const authorities = useTelemetryStore((s) => s.babeAuthorities);
  if (authorities.length === 0) return null;
  return (
    <details className="mt-6 border border-border bg-white px-4 py-3">
      <summary className="cursor-pointer font-accent text-sm text-ink-body select-none">
        BABE Authorities ({authorities.length})
      </summary>
      <ul className="mt-3 space-y-1 font-mono text-xs text-ink-strong">
        {authorities.map((a) => (
          <li key={a.accountId}>
            {a.accountId}
            {a.displayName && (
              <span className="ml-2 font-accent text-ink-subtle">— {a.displayName}</span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
