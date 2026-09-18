// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Browser copy of each node's last `/api/node/{account}/summary` answer, so a
// node page renders what it last saw while the backend refreshes it. The
// backend stays the source of truth; every call here degrades to "no cached
// value" when IndexedDB is missing, blocked, or fails.

import type { NodeSummaryResponse } from "@quip/shared/telemetry";

export interface NodeSummaryCache {
  read(accountId: string): Promise<NodeSummaryResponse | null>;
  write(accountId: string, value: NodeSummaryResponse): Promise<void>;
}

const DB_NAME = "quip-dashboard";
const DB_VERSION = 1;
const STORE = "node-summaries";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

// Run one request against the store; null when IndexedDB is unavailable or
// the request fails.
async function run<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest,
): Promise<T | null> {
  const db = await openDb();
  if (db === null) return null;
  return new Promise((resolve) => {
    try {
      const request = op(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export const indexedDbNodeSummaryCache: NodeSummaryCache = {
  read: (accountId) => run<NodeSummaryResponse>("readonly", (store) => store.get(accountId)),
  write: async (accountId, value) => {
    await run("readwrite", (store) => store.put(value, accountId));
  },
};
