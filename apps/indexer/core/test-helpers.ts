// SPDX-License-Identifier: AGPL-3.0-or-later

import type { IndexerConfig } from "./config";

// The in-memory Postgres adapter factory lives with the DB layer in @quip/core;
// re-exported here so indexer tests keep importing it from one place.
export { newInMemoryAdapter } from "@quip/core/test-helpers";

export function makeConfig(overrides: Partial<IndexerConfig> = {}): IndexerConfig {
  return {
    validatorRpcUrls: ["ws://test-validator:9944"],
    pollIntervalSec: 8,
    nodesRefreshSec: 45,
    once: false,
    verbose: false,
    stallWarnAfterSec: 600,
    substrateRpcTimeoutMs: 15000,
    substrateReconnectMaxBackoffMs: 60000,
    substrateBabePollSec: 30,
    substrateChainPollSec: 300,
    substrateBackfillBlocksPerSec: 5,
    substrateBackfillConcurrency: 4,
    operatorAccount: null,
    reindex: null,
    listIndexables: false,
    ...overrides,
  };
}

export interface FakeResponseSpec {
  status: number;
  etag?: string | null;
  body?: unknown;
  // raw body text that bypasses JSON.stringify (used to inject big-int literals)
  rawText?: string;
}

export type Router = (url: string, init: RequestInit | undefined) => FakeResponseSpec;

/**
 * Build a `fetch`-shaped stub that dispatches each request through `router`.
 * Kept around for tests that exercise QuipClient transport behavior (status
 * code mapping, envelope unwrapping, header handling). New tip-worker tests
 * fake the client directly and don't need this.
 */
export function makeFetch(router: Router): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const spec = router(url, init);
    const text =
      spec.rawText !== undefined
        ? spec.rawText
        : spec.body !== undefined
          ? JSON.stringify({ success: true, data: spec.body })
          : "";
    const headers = new Headers();
    if (spec.etag) headers.set("etag", spec.etag);
    const res = new Response(spec.status === 304 ? null : text, {
      status: spec.status,
      headers,
    });
    Object.defineProperty(res, "url", { value: url, configurable: true });
    return res;
  };
  return fn as typeof fetch;
}
