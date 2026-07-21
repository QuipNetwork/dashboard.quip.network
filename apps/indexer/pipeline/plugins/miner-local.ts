// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `miner-local` (spec §4.1): descriptor-only registry entry for the miner's
// own REST-sourced data (self stats, heartbeat, mining submissions). The
// SnapshotScheduler skips `driver: "tip-worker"` entries; the fatal TipWorker
// keeps driving the actual iteration on its own timer — an unreachable miner
// API is a deploy/config error the operator must see immediately, so its
// failures must stay fatal rather than becoming logged snapshot errors. This
// entry exists so `--list-indexables` shows the complete R9 taxonomy.

import type { IndexerConfig } from "../../core/config";
import type { SnapshotIndexable } from "../plugin";

export function minerLocalPlugin(): SnapshotIndexable {
  return {
    name: "miner-local",
    kind: "snapshot",
    driver: "tip-worker",

    intervalSec: (cfg: IndexerConfig) => cfg.pollIntervalSec,

    async poll(): Promise<void> {
      // Never called: the SnapshotScheduler skips tip-worker-driven entries
      // and TipWorker runs its own iteration (tip/worker.ts). Descriptive
      // registry presence only.
    },

    async dropState(): Promise<void> {
      // Documented no-op (spec §8): tip data re-accumulates from the live
      // miner; `resetMiningHistory` (adapter.ts) remains the targeted
      // maintenance primitive.
    },
  };
}
