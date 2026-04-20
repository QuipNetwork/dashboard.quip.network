// SPDX-License-Identifier: AGPL-3.0-or-later

import type { IndexerCursor } from "../src/types/telemetry";
import type { DatabaseAdapter } from "../api/db/adapter";

export interface EtagState {
  status: string | null;
  nodes: string | null;
}

/**
 * In-memory cache of the indexer's cursor and etag state, backed by the
 * DatabaseAdapter. Callers mutate {@link cursor} / {@link etags} and call
 * {@link save} to persist.
 */
export class IndexerState {
  cursor: IndexerCursor = { epoch: null, blockIndex: 0 };
  etags: EtagState = { status: null, nodes: null };

  constructor(private readonly db: DatabaseAdapter) {}

  async load(): Promise<void> {
    this.cursor = await this.db.getCursor();
    this.etags = await this.db.getEtags();
  }

  async save(): Promise<void> {
    await this.db.saveCursor(this.cursor, {
      status: this.etags.status,
      nodes: this.etags.nodes,
    });
  }
}
