// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseAdapter } from "./api/db/adapter";
import { createPgliteHarness, type PgliteHarness } from "./api/db/pglite-support";

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
