// SPDX-License-Identifier: AGPL-3.0-or-later

import { selectTipBlock, useTelemetryStore } from "../../store/telemetry-store";

export function CurrentBlockIndicator() {
  // Select the tip block directly (stable reference across renders) rather
  // than a derived coord object, which would be a fresh object each call and
  // trigger an infinite re-render loop with zustand's default equality check.
  const tip = useTelemetryStore(selectTipBlock);
  if (!tip) return null;
  // v0.3 has no PoW epoch concept — substrate block height is the canonical
  // chain coordinate. The "mining now" cue points at the next substrate block.
  const next = Number(tip.substrateBlockNumber) + 1;
  return (
    <p className="mt-2 text-center font-accent text-xs text-brand-gray-3">
      Mining block <span className="text-brand-gray-5">#{next}</span>
    </p>
  );
}
