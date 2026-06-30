// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseAdapter } from "@quip/core/db/adapter";

export interface ChainStateReader {
  currentGlobalSolutionNumber(): Promise<number | null>;
}

export class DbChainStateReader implements ChainStateReader {
  constructor(private readonly db: DatabaseAdapter) {}

  async currentGlobalSolutionNumber(): Promise<number | null> {
    const head = await this.db.getChainHead();
    if (!head || head.qblockCount === null) return null;
    return head.qblockCount + 1;
  }
}
