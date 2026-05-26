// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseAdapter } from "./db/adapter";

/**
 * Resolve the base URL the indexer / server should hit for the local
 * operator's miner-REST surface (`/api/v1/status`, `/api/v1/stats`,
 * `/api/v1/mining/attempts`).
 *
 * Resolution order:
 *   1. Descriptor lookup. If `selfAccountId` is known AND a
 *      `node_descriptors` row for it carries a `publicHost`, build
 *      `https://host[:port]`. The operator's own signed descriptor is
 *      the authoritative answer when it has landed on-chain.
 *   2. Fallback derivation from `validatorRpcUrls[0]`. Substitute
 *      `ws://` → `http://`, `wss://` → `https://`, and strip a trailing
 *      `/rpc` path component. The host and port carry through
 *      unchanged. This is the bootstrap path on a fresh DB (no
 *      selfAccountId yet) and the steady-state path in deployments
 *      where the operator hasn't signed a descriptor — the indexer
 *      hits this URL once, the miner replies with its SS58 via
 *      /api/v1/status, and that response back-fills selfAddress.
 *
 * Returns null only when `validatorRpcUrls` is empty (impossible in
 * production — parseConfig enforces ≥ 1 entry).
 */
export async function resolveSelfMinerRestUrl(
  db: DatabaseAdapter,
  validatorRpcUrls: string[],
  selfAccountId: string | null,
): Promise<string | null> {
  if (selfAccountId) {
    const descriptor = await db.getNodeDescriptor(selfAccountId);
    const publicHost = descriptor?.descriptor.publicHost;
    if (publicHost) {
      const port = descriptor?.descriptor.publicPort;
      return port ? `https://${publicHost}:${port}` : `https://${publicHost}`;
    }
  }
  const primary = validatorRpcUrls[0];
  if (!primary) return null;
  return deriveMinerRestFromRpcUrl(primary);
}

/**
 * Pure transformation used by the fallback branch. Exported for unit
 * tests; the descriptor-aware resolver delegates here only when no
 * `publicHost` is on file.
 *
 *   ws://quip-validator:9944       → http://quip-validator:9944
 *   wss://example.com/rpc          → https://example.com
 *   wss://example.com:443/rpc/ws   → https://example.com:443/ws
 */
export function deriveMinerRestFromRpcUrl(rpcUrl: string): string {
  let out = rpcUrl.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
  // Strip a trailing `/rpc` (or `/rpc/`) so the resulting base URL ends
  // at the host. Anything past `/rpc` is kept — Polkadot RPC endpoints
  // occasionally append `/ws` or similar after `/rpc`.
  out = out.replace(/\/rpc(?=\/|$)/i, "");
  // Trim any leftover trailing slash for stable concatenation with
  // `/api/v1/...` paths downstream.
  return out.replace(/\/+$/, "");
}
