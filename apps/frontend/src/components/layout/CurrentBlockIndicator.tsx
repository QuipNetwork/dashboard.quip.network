// SPDX-License-Identifier: AGPL-3.0-or-later

import { winningSolutionsSolved } from "@/lib/chain-solutions";
import { blocksSinceLastProof, decaysApplied } from "@/lib/decays";
import { selectTipBlock, useTelemetryStore } from "@/store/telemetry-store";

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
  // to the substrate block height. It's `LatestQBlockId + 1`, sourced from
  // chain via `chain_head.qblockCount` (falling back to summing
  // `quantum_pow.Miners[*].proofs_won` until chain_head lands).
  const tipNum = Number(tip.substrateBlockNumber);
  const nextProblem = winningSolutionsSolved(chainHead, chainMiners) + 1;
  // Substrate blocks elapsed since the last winning PoW solution, and the
  // decay steps that implies — both anchored on the BEST head (see
  // lib/decays.ts: the runtime decays with the executing chain, and the old
  // finalized-anchored count undercounted whenever finality lagged). Hidden
  // when chain_head isn't observed yet (substrate worker not connected).
  const blocksSinceWin = blocksSinceLastProof(chainHead, tip.substrateBlockNumber);
  const decays = decaysApplied(chainHead, tip.substrateBlockNumber);
  // Number of miners that declared participation on the in-flight qblock via
  // `MinerRegistry.participate`, sourced from chain. Null when the runtime API
  // is absent (pre-v0.2) or the substrate worker hasn't read it yet.
  const participants = chainHead?.currentQBlockParticipants ?? null;
  return (
    <div className="mt-2 text-center font-accent text-xs text-ink-subtle">
      <p>
        Mining QBlock <span className="text-ink-strong">#{nextProblem}</span>
        {participants != null && (
          <span className="text-ink-subtle">
            {" "}
            · {participants} {participants === 1 ? "participant" : "participants"}
          </span>
        )}
      </p>
      <p className="mt-0.5 text-ink-subtle">
        Last PoW Block: <span className="text-ink-body">#{tipNum}</span>
        {blocksSinceWin != null && (
          <span className="text-ink-subtle"> · {blocksSinceWin} blocks since</span>
        )}
        {decays != null && decays > 0 && (
          <span className="text-ink-subtle">
            {" "}
            · {decays} {decays === 1 ? "decay" : "decays"}
          </span>
        )}
      </p>
    </div>
  );
}
