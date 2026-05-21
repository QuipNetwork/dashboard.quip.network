// SPDX-License-Identifier: AGPL-3.0-or-later

import { selectTipBlock, useTelemetryStore } from "../../store/telemetry-store";

export function CurrentBlockIndicator() {
  // Select the tip block directly (stable reference across renders) rather
  // than a derived coord object, which would be a fresh object each call and
  // trigger an infinite re-render loop with zustand's default equality check.
  const tip = useTelemetryStore(selectTipBlock);
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  if (!tip) return null;
  // BABE authors most blocks without a PoW solution attached, so the
  // "problem number" the network is currently racing to solve isn't tied
  // to the substrate block height. It's the count of proofs ever won
  // across all chain miners + 1. `quantum_pow.Miners[*].proofs_won` is the
  // authoritative lifetime counter.
  const tipNum = Number(tip.substrateBlockNumber);
  const totalProofsWon = chainMiners.reduce((sum, m) => sum + Number(m.proofsWon || "0"), 0);
  const nextProblem = totalProofsWon + 1;
  return (
    <div className="mt-2 text-center font-accent text-xs text-brand-gray-3">
      <p>
        Mining Problem <span className="text-brand-gray-5">#{nextProblem}</span>
      </p>
      <p className="mt-0.5 text-brand-gray-3">
        Current Block: <span className="text-brand-gray-4">#{tipNum}</span>
      </p>
    </div>
  );
}
