// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Global test teardown, loaded via `bunfig.toml`'s `[test] preload`.
//
// Bun runs a preload once per test process, and a lifecycle hook registered
// here fires once for the whole run — not per file. That makes this the only
// place that can free the pglite instance `newInMemoryAdapter()` shares across
// every file without making each file pay the init again.
//
// Without it a fully green run exits 99 (clean results, unclean exit) because
// the WASM instance is still open when Bun tears the process down.

import { afterAll } from "bun:test";

import { closeSharedInMemoryAdapter } from "./test-helpers";

afterAll(async () => {
  await closeSharedInMemoryAdapter();
});
