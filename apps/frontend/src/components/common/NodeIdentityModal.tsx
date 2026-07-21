// SPDX-License-Identifier: AGPL-3.0-or-later

import clsx from "clsx";
import type { ReactNode } from "react";

import { Modal } from "@/components/ui/Modal";
import { displayNodeName, formatBalance, shortAddress } from "@/lib/format-chain";
import type { ChainMinerRecord, NodeDescriptorRecord, NodeInfo } from "@quip/shared/telemetry";

/**
 * Reusable full-identity dialog for a single chain account. Surfaces
 * everything the old `NodeIdentitiesPanel` card showed — rig name, account,
 * runtime badges, CPU/GPU/system inventory, declared miners, and the
 * reachable host:port — plus the on-chain miner counters when available.
 *
 * `record` is the operator-signed descriptor (may be absent for a miner that
 * never published one). `miner`/`node` are optional supplements: the chain
 * miner row for deposit/rewards and the telemetry NodeInfo for live hardware.
 */
export function NodeIdentityModal({
  accountId,
  record,
  miner,
  node,
  onClose,
  onMoreInfo,
}: {
  accountId: string;
  record?: NodeDescriptorRecord;
  miner?: ChainMinerRecord;
  node?: NodeInfo;
  onClose: () => void;
  // When provided, renders a "More info" link that opens the full node page
  // for this account (live stats, in-flight dispatch, leaderboard rank).
  onMoreInfo?: () => void;
}) {
  const d = record?.descriptor;
  const name = displayNodeName(accountId, d?.nodeName);
  // Prefer the descriptor's self-asserted hardware; fall back to the live
  // telemetry NodeInfo when the descriptor carries none.
  const systemInfo = d?.systemInfo ?? node?.systemInfo;
  const runtime = d?.runtime ?? node?.runtime;
  const miners = d?.miners ?? node?.miners;
  const minerEntries = miners ? Object.values(miners) : [];
  const gpus = systemInfo?.gpus ?? [];
  const publicHost = d?.publicHost ?? node?.publicHost;
  const publicPort = d?.publicPort ?? node?.publicPort;

  // CPUs the operator declared the miner uses (chain-signed), not host
  // logical cores — same convention as the compute tiles.
  const cpuMinerCpus = minerEntries.reduce(
    (sum, m) => (m.kind === "CPU" ? sum + (m.numCpus ?? 0) : sum),
    0,
  );
  const cpuLine = systemInfo?.cpu?.brand
    ? `${systemInfo.cpu.brand}${
        cpuMinerCpus > 0 ? ` (${cpuMinerCpus} CPU${cpuMinerCpus === 1 ? "" : "s"})` : ""
      }`
    : null;

  return (
    <Modal isOpen onClose={onClose} size="xl" ariaLabel={`${name} node identity`}>
      <Modal.Header>{name}</Modal.Header>
      <Modal.Body>
        <p className="mb-2 break-all font-mono text-xs text-ink-subtle" title={accountId}>
          {accountId}
        </p>

        {onMoreInfo && (
          <button
            type="button"
            onClick={onMoreInfo}
            className="mb-3 cursor-pointer font-accent text-xs uppercase tracking-wider text-ink-strong underline-offset-2 hover:underline"
          >
            More info →
          </button>
        )}

        <div className="mb-4 flex flex-wrap gap-1 font-accent text-[10px] uppercase tracking-wider">
          {runtime?.quipVersion && <Badge label={`quip ${runtime.quipVersion}`} tone="info" />}
          {runtime?.inDocker && <Badge label="docker" tone="muted" />}
          {record == null && <Badge label="no descriptor" tone="muted" />}
        </div>

        <dl className="grid grid-cols-1 gap-x-4 gap-y-3 font-accent text-sm sm:grid-cols-2">
          {cpuLine && <Row label="CPU" value={cpuLine} />}
          {systemInfo?.cpu?.logicalCores != null && (
            <Row label="Logical Cores" value={String(systemInfo.cpu.logicalCores)} />
          )}
          {systemInfo?.memoryMb != null && (
            <Row label="System Memory" value={`${(systemInfo.memoryMb / 1024).toFixed(1)} GB`} />
          )}
          {gpus.length > 0 && (
            <Row
              label={`GPU${gpus.length > 1 ? `s (${gpus.length})` : ""}`}
              span={2}
              value={gpus
                .map((g) => {
                  const mem = g.memoryMb != null ? ` ${(g.memoryMb / 1024).toFixed(0)}GB` : "";
                  const util =
                    g.observedUtilizationPct != null
                      ? ` @ ${g.observedUtilizationPct.toFixed(0)}%`
                      : "";
                  return `${g.name ?? "unknown"}${mem}${util}`;
                })
                .join(" · ")}
            />
          )}
          {minerEntries.length > 0 && (
            <Row
              label="Miners"
              span={2}
              value={minerEntries.map((m) => `${m.kind}/${m.minerId}`).join(" · ")}
            />
          )}
          {publicHost && (
            <Row
              label="Reachable"
              mono
              value={`${publicHost}${publicPort ? `:${publicPort}` : ""}`}
            />
          )}
          {miner && (
            <>
              <Row label="Deposit" value={formatBalance(miner.deposit)} />
              <Row label="Rewards" value={formatBalance(miner.rewardsEarned)} />
              {/* Lifetime chain counters from `quantum_pow.Miners` storage —
                  deliberately labeled so they aren't read as the indexed
                  all-time counts the leaderboard/rank tables show (those
                  come from /api/miner-wins and can trail the chain while
                  backfill is incomplete). */}
              <Row label="Proofs Submitted (lifetime)" value={miner.proofsSubmitted} />
              <Row label="Proofs Won (lifetime)" value={miner.proofsWon} />
            </>
          )}
        </dl>

        {record == null && minerEntries.length === 0 && !cpuLine && (
          <p className="mt-4 font-accent text-sm text-ink-subtle">
            No published node descriptor for {shortAddress(accountId)} yet — hardware and runtime
            details appear once the operator runs <code>quip-miner identify</code>.
          </p>
        )}
      </Modal.Body>
    </Modal>
  );
}

function Row({
  label,
  value,
  mono = false,
  span = 1,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  span?: 1 | 2;
}) {
  return (
    <div className={span === 2 ? "sm:col-span-2" : ""}>
      <dt className="text-[10px] uppercase tracking-wider text-ink-subtle">{label}</dt>
      <dd className={clsx("tabular-nums text-ink-strong", mono && "break-all font-mono text-xs")}>
        {value}
      </dd>
    </div>
  );
}

function Badge({ label, tone }: { label: string; tone: "info" | "muted" | "success" }) {
  const cls =
    tone === "info"
      ? "bg-surface-2 text-ink-strong"
      : tone === "success"
        ? "bg-positive/20 text-positive"
        : "bg-surface-1 text-ink-subtle";
  return <span className={clsx("px-2 py-0.5", cls)}>{label}</span>;
}
