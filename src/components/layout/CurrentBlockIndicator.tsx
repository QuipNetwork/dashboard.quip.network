// SPDX-License-Identifier: AGPL-3.0-or-later

import { winningSolutionsSolved } from "../../lib/chain-solutions";
import { selectTipBlock, useTelemetryStore } from "../../store/telemetry-store";

export function CurrentBlockIndicator() {
  // Select the tip block directly (stable reference across renders) rather
  // than a derived coord object, which would be a fresh object each call and
  // trigger an infinite re-render loop with zustand's default equality check.
  const tip = useTelemetryStore(selectTipBlock);
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const chainHead = useTelemetryStore((s) => s.chainHead);
  if (!tip) return null;
  // BABE authors most blocks without a PoW solution attached, so the
  // "problem number" the network is currently racing to solve isn't tied
  // to the substrate block height. It's `count(WinningSolutions) + 1`,
  // sourced from chain via `chain_head.winningSolutionsCount` (falling back
  // to summing `quantum_pow.Miners[*].proofs_won` until chain_head lands).
  const tipNum = Number(tip.substrateBlockNumber);
  const nextProblem = winningSolutionsSolved(chainHead, chainMiners) + 1;
  // Substrate blocks elapsed since the last winning PoW solution. Derived
  // from chain_head.finalizedBlockNumber (the canonical "where the chain
  // is now") minus the tip-of-winning-blocks substrate height. Hidden when
  // chain_head isn't observed yet (substrate worker not connected).
  const finalizedNum =
    chainHead && chainHead.finalizedBlockNumber ? Number(chainHead.finalizedBlockNumber) : null;
  const blocksSinceWin = finalizedNum != null ? Math.max(0, finalizedNum - tipNum) : null;
  // Number of difficulty-decay steps applied since the last winning proof.
  // quip-protocol-rs `apply_decay` triggers every `EpochLength` blocks past
  // `LastProofBlock` (see pallets/quantum-pow/src/difficulty.rs:261). Hard-
  // coded to match `QuantumPowEpochLength = 100` on spec 101; pipe through
  // telemetry if/when the constant ever varies per chain.
  const QUANTUM_POW_EPOCH_LENGTH = 100;
  const decaysApplied =
    blocksSinceWin != null ? Math.floor(blocksSinceWin / QUANTUM_POW_EPOCH_LENGTH) : null;
  return (
    <div className="mt-2 text-center font-accent text-xs text-brand-gray-3">
      <p>
        Mining Problem <span className="text-brand-gray-5">#{nextProblem}</span>
      </p>
      <p className="mt-0.5 text-brand-gray-3">
        Last PoW Block: <span className="text-brand-gray-4">#{tipNum}</span>
        {blocksSinceWin != null && (
          <span className="text-brand-gray-3"> · {blocksSinceWin} blocks since</span>
        )}
        {decaysApplied != null && decaysApplied > 0 && (
          <span className="text-brand-gray-3">
            {" "}
            · {decaysApplied} {decaysApplied === 1 ? "decay" : "decays"}
          </span>
        )}
      </p>
    </div>
  );
}
