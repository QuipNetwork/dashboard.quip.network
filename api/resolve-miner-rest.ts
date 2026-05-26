// SPDX-License-Identifier: AGPL-3.0-or-later

import type { NodeDescriptorRecord } from "../src/types/telemetry";

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

/**
 * Build the miner-REST base URL from a descriptor row. Shared between the
 * descriptor-aware resolver and the discovery probe so both produce the
 * same canonical shape for a given (publicHost, publicPort) pair.
 */
function descriptorRestBaseUrl(record: NodeDescriptorRecord): string | null {
  const host = record.descriptor.publicHost;
  if (!host) return null;
  const port = record.descriptor.publicPort;
  return port ? `https://${host}:${port}` : `https://${host}`;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const DEFAULT_MAX_PROBES = 8;

/**
 * Discover the local operator's SS58 by probing every `node_descriptors`
 * row that carries a `publicHost`. Solves the bootstrap chicken-and-egg
 * that bit split-host deployments (chain RPC and miner REST on different
 * hostnames): tip-worker needs `selfAddress` to resolve the REST URL,
 * but `selfAddress` only gets cached after a successful REST call.
 *
 * Strategy: for each candidate URL, fetch `/api/v1/status`. A descriptor
 * is considered "self" only when the returned `ss58_address` matches the
 * descriptor's signer account (the row's `accountId`). This filters out
 * descriptors from other operators on a multi-tenant dashboard — probing
 * their nodes returns *their* SS58, which won't equal *our* signer.
 *
 * Returns the first self-consistent SS58 found, or null when no candidate
 * responds with a matching identity. Caps probes at `maxProbes` to bound
 * a tick's worst-case work on a large descriptor table.
 */
export async function discoverLocalOperator(
  db: DatabaseAdapter,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxProbes?: number;
  } = {},
): Promise<string | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const maxProbes = options.maxProbes ?? DEFAULT_MAX_PROBES;

  const descriptors = await db.getAllNodeDescriptors();
  let probed = 0;
  for (const row of descriptors) {
    if (probed >= maxProbes) break;
    const baseUrl = descriptorRestBaseUrl(row);
    if (!baseUrl) continue;
    probed++;
    const reported = await probeStatusSs58(baseUrl, fetchImpl, timeoutMs);
    if (reported && reported === row.accountId) {
      return reported;
    }
  }
  return null;
}

/**
 * Single-URL probe. Returns the `ss58_address` reported by the miner's
 * `/api/v1/status`, or null on any failure (non-2xx, malformed envelope,
 * network error, timeout). Caller compares against the descriptor's
 * signer for self-consistency.
 */
async function probeStatusSs58(
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/api/v1/status`, {
      headers: { accept: "application/json" },
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const parsed = (await res.json()) as {
      success?: boolean;
      data?: { ss58_address?: unknown };
    };
    if (!parsed || parsed.success === false) return null;
    const ss58 = parsed.data?.ss58_address;
    return typeof ss58 === "string" && ss58.length > 0 ? ss58 : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
