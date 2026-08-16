// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseAdapter } from "./api/db/adapter";
import { createPgliteHarness, type PgliteHarness } from "./api/db/pglite-support";

// One shared in-process Postgres (pglite) for the whole test process; each
// call truncates it so tests don't share state. pglite init (~1.5s) is paid
// once. adapter.disconnect() is a no-op on the shared instance, so the common
// "disconnect in afterEach" stays harmless.
let shared: PgliteHarness | null = null;

/**
 * Free the shared pglite. Called once per test process from the
 * `packages/core/test-preload.ts` hook that `bunfig.toml` loads.
 *
 * `closeAdapterOnDisconnect: false` makes `adapter.disconnect()` a no-op, which
 * is what lets 20-odd files share one instance — but it also means nothing ever
 * calls `pg.close()`. The WASM instance then outlives the last test and Bun
 * ends a run where every test passed with exit code 99: a clean result and an
 * unclean exit. Closing here restores a 0.
 *
 * Do NOT call this from a per-file `afterAll`. The next file would pay the
 * pglite init again, and the sharing this helper exists for would be gone.
 */
export async function closeSharedInMemoryAdapter(): Promise<void> {
  if (!shared) return;
  const harness = shared;
  shared = null;
  await harness.close();
}

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
