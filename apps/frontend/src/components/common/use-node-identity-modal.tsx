// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState, type ReactNode } from "react";

import { NodeIdentityModal } from "@/components/common/NodeIdentityModal";
import { useTelemetryStore } from "@/store/telemetry-store";

/**
 * Shared wiring for the reusable node-identity modal. Any table that lists
 * accounts (on-chain miners, the leaderboard, rank-adjacent neighbours) can:
 *   - resolve an account's rig name via `nameOf(accountId)` (for display), and
 *   - open the modal for an account via `open(accountId)`,
 * then render `modal` once after the table. The modal merges the chain-signed
 * descriptor, the on-chain miner row, and the live telemetry node for that
 * account — exactly what `NodeIdentityModal` expects.
 */
export function useNodeIdentityModal(): {
  open: (accountId: string) => void;
  nameOf: (accountId: string) => string | undefined;
  modal: ReactNode;
} {
  const nodeDescriptors = useTelemetryStore((s) => s.nodeDescriptors);
  const chainMiners = useTelemetryStore((s) => s.chainMiners);
  const nodes = useTelemetryStore((s) => s.nodes);
  const [openAccountId, setOpenAccountId] = useState<string | null>(null);

  const descriptorsByAccount = useMemo(
    () => new Map(nodeDescriptors.map((d) => [d.accountId, d])),
    [nodeDescriptors],
  );

  const nameOf = (accountId: string): string | undefined =>
    descriptorsByAccount.get(accountId)?.descriptor.nodeName;

  let modal: ReactNode = null;
  if (openAccountId) {
    const miner = chainMiners.find((m) => m.accountId === openAccountId);
    const record = descriptorsByAccount.get(openAccountId);
    const node =
      miner?.telemetryNodeAddress != null ? nodes?.nodes[miner.telemetryNodeAddress] : undefined;
    modal = (
      <NodeIdentityModal
        accountId={openAccountId}
        record={record}
        miner={miner}
        node={node}
        onClose={() => setOpenAccountId(null)}
      />
    );
  }

  return { open: setOpenAccountId, nameOf, modal };
}
