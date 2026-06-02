// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Resolve the base URL the indexer / server should hit for the LOCAL
 * operator's miner-REST surface (`/api/v1/status`, `/api/v1/stats`,
 * `/api/v1/mining/attempts`).
 *
 * This is intentionally LOCAL-ONLY. It derives the URL from the configured
 * front door (`validatorRpcUrls[0]` — Caddy, which serves both `/rpc` and
 * `/api/v1` for the co-located stack). We deliberately do NOT consult on-chain
 * descriptors to locate "self": a descriptor's advertised `publicHost` can be
 * any reachable network node, and adopting one would mis-identify this
 * deployment as somebody else's node. If the local miner is unreachable this
 * still returns the front-door URL — whose `/api/v1` probe then fails, and the
 * caller surfaces that (warning + empty self state) instead of silently
 * latching onto a global node.
 *
 * Returns null only when `validatorRpcUrls` is empty (impossible in
 * production — parseConfig enforces ≥ 1 entry).
 */
export function resolveSelfMinerRestUrl(validatorRpcUrls: string[]): string | null {
  const primary = validatorRpcUrls[0];
  if (!primary) return null;
  return deriveMinerRestFromRpcUrl(primary);
}

/**
 * Pure transformation from the front-door RPC URL to the miner-REST base URL.
 * Substitute `ws://` → `http://` / `wss://` → `https://` and strip a trailing
 * `/rpc` path component so the result ends at the host that also serves
 * `/api/v1`.
 *
 *   ws://quip-validator:9944       → http://quip-validator:9944
 *   ws://quip-caddy:8088/rpc       → http://quip-caddy:8088
 *   wss://example.com/rpc          → https://example.com
 *   wss://example.com:443/rpc/ws   → https://example.com:443/ws
 */
export function deriveMinerRestFromRpcUrl(rpcUrl: string): string {
  let out = rpcUrl.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
  // Strip a trailing `/rpc` (or `/rpc/`) so the resulting base URL ends at the
  // host. Anything past `/rpc` is kept — Polkadot RPC endpoints occasionally
  // append `/ws` or similar after `/rpc`.
  out = out.replace(/\/rpc(?=\/|$)/i, "");
  // Trim any leftover trailing slash for stable concatenation with `/api/v1`.
  return out.replace(/\/+$/, "");
}
