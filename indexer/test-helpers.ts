// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseAdapter } from "../api/db/adapter";
import { SQLiteAdapter } from "../api/db/sqlite";

import type { IndexerConfig } from "./config";

/**
 * Test factory: in-memory SQLite adapter wired to the v6 schema. Each call
 * yields a fresh DB so tests don't share state. Prefer this over a hand-
 * rolled fake — exercising the real adapter catches schema/migration drift
 * the fake would mask.
 */
export async function newInMemoryAdapter(): Promise<DatabaseAdapter> {
  const adapter = new SQLiteAdapter({ adapter: "sqlite", sqlitePath: ":memory:" });
  await adapter.connect();
  await adapter.migrate();
  return adapter;
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
