// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatEpochId } from "../../lib/format";
import { selectTipBlock, useTelemetryStore } from "../../store/telemetry-store";

export function CurrentBlockIndicator() {
  // Select the tip block directly (stable reference across renders) rather
  // than a derived coord object, which would be a fresh object each call and
  // trigger an infinite re-render loop with zustand's default equality check.
  const tip = useTelemetryStore(selectTipBlock);
  if (!tip) return null;
  // Tip block timestamp is the freshest "mining now" cue for an in-progress
  // epoch — no need to look up block 1 separately here.
  return (
    <p className="mt-2 text-center font-accent text-xs text-brand-gray-3">
      Mining block <span className="text-brand-gray-5">#{tip.blockIndex + 1}</span> of Epoch{" "}
      <span className="text-brand-gray-5">{formatEpochId(tip.epoch, tip.timestamp)}</span>
    </p>
  );
}
