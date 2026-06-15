// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseAdapter } from "../api/db/adapter";
import { createPgliteHarness, type PgliteHarness } from "../api/db/pglite-support";

import type { IndexerConfig } from "./config";

// One shared in-process Postgres (pglite) for the whole test process; each
// call truncates it so tests don't share state. pglite init (~1.5s) is paid
// once. adapter.disconnect() is a no-op on the shared instance, so the common
// "disconnect in afterEach" stays harmless.
let shared: PgliteHarness | null = null;

/**
 * Test factory: a migrated in-memory Postgres adapter (real Postgres semantics
 * via pglite). Each call yields a clean DB. Prefer this over a hand-rolled fake
 * — exercising the real adapter catches schema/migration drift the fake masks.
 */
export async function newInMemoryAdapter(): Promise<DatabaseAdapter> {
  if (!shared) shared = await createPgliteHarness({ closeAdapterOnDisconnect: false });
  // Re-attach: a prior test's disconnect() nulls the adapter's handle. connect()
  // is idempotent for the injected db (just re-points it at the shared pglite).
  await shared.adapter.connect();
  await shared.reset();
  return shared.adapter;
}

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
    descriptorStartBlock: "1",
    operatorAccount: null,
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
