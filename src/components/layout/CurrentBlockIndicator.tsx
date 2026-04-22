// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatEpochTimestamp } from "../../lib/format";
import { selectTipBlock, useTelemetryStore } from "../../store/telemetry-store";

export function CurrentBlockIndicator() {
  // Select the tip block directly (stable reference across renders) rather
  // than a derived coord object, which would be a fresh object each call and
  // trigger an infinite re-render loop with zustand's default equality check.
  const tip = useTelemetryStore(selectTipBlock);
  if (!tip) return null;
  return (
    <p className="mt-2 text-center font-accent text-xs text-brand-gray-3">
      Mining block <span className="text-brand-gray-5">#{tip.blockIndex + 1}</span> of Epoch{" "}
      <span className="text-brand-gray-5">{formatEpochTimestamp(tip.epoch)}</span>
    </p>
  );
}
