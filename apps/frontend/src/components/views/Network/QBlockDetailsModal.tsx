// SPDX-License-Identifier: AGPL-3.0-or-later

import clsx from "clsx";

import { Modal } from "@/components/ui/Modal";
import { formatDuration } from "@/lib/format";
import { formatBalance, formatEnergy, formatNonce, shortAddress } from "@/lib/format-chain";
import type { BlockRecord } from "@quip/shared/telemetry";

export function QBlockDetailsModal({
  block,
  solutionNumber,
  onClose,
}: {
  block: BlockRecord;
  solutionNumber: number;
  onClose: () => void;
}) {
  const completedAt = new Date(block.timestamp * 1000).toISOString();

  return (
    <Modal isOpen onClose={onClose} size="xl" ariaLabel={`QBlock #${solutionNumber} details`}>
      <Modal.Header>QBlock #{solutionNumber}</Modal.Header>
      <Modal.Body>
        <p className="mb-4 font-accent text-xs text-ink-subtle">
          Block #{block.substrateBlockNumber}{" "}
          {block.finalized ? "· finalized" : "· best (unfinalized)"}
        </p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 font-accent text-sm">
          <Row
            label="Winner"
            value={shortAddress(block.minerId, 8, 6)}
            mono
            title={block.minerId}
          />
          <Row label="Energy" value={formatEnergy(block.energy)} />
          <Row label="Target Energy" value={formatEnergy(block.difficultyEnergy)} />
          <Row label="Diversity" value={block.diversity.toFixed(3)} />
          <Row label="Min Diversity" value={block.minDiversity.toFixed(3)} />
          <Row label="Solutions Found" value={String(block.numValidSolutions)} />
          <Row label="Min Solutions" value={String(block.minSolutions)} />
          <Row label="Time to QBlock" value={formatDuration(block.miningTime * 1000)} />
          <Row label="Reward" value={formatBalance(block.reward)} />
          <Row label="Nodes" value={String(block.numNodes)} />
          <Row label="Edges" value={String(block.numEdges)} />
          <Row label="Completed At" value={completedAt} />
          <Row
            label="Substrate Block Hash"
            value={shortAddress(block.substrateBlockHash, 10, 8)}
            mono
            title={block.substrateBlockHash}
            span={2}
          />
          <Row
            label="Parent Hash"
            value={shortAddress(block.substrateParentHash, 10, 8)}
            mono
            title={block.substrateParentHash}
            span={2}
          />
          <Row
            label="QBlock Hash"
            value={shortAddress(block.blockHash, 10, 8)}
            mono
            title={block.blockHash}
            span={2}
          />
          <Row label="Nonce" value={formatNonce(block.nonce)} mono title={block.nonce} span={2} />
        </dl>
      </Modal.Body>
    </Modal>
  );
}

function Row({
  label,
  value,
  mono = false,
  title,
  span = 1,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
  span?: 1 | 2;
}) {
  return (
    <div className={span === 2 ? "col-span-2" : ""}>
      <dt className="text-[10px] uppercase tracking-wider text-ink-subtle">{label}</dt>
      <dd
        title={title}
        className={clsx("tabular-nums text-ink-strong", mono && "break-all font-mono text-xs")}
      >
        {value}
      </dd>
    </div>
  );
}
