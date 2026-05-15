// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BabeAuthorityRecord,
  BabeEpochState,
  BlockRecord,
  ChainHead,
  ChainMinerRecord,
  DifficultyRecord,
  EpochId,
  IndexerCursor,
  IndexerObservability,
  NodesSnapshot,
  TelemetryIndex,
} from "../src/types/telemetry";
import type { DatabaseAdapter, EpochStatusEntry } from "../api/db/adapter";

import type { IndexerConfig } from "./config";

/**
 * In-memory `DatabaseAdapter` used across indexer tests. Instantiated with
 * `new FakeDb()` (kept as a class rather than a factory so test assertions can
 * still read direct fields like `db.inserted`).
 */
export class FakeDb implements DatabaseAdapter {
  connected = false;
  migrated = false;
  inserted: BlockRecord[] = [];
  upserted: NodesSnapshot[] = [];
  savedCursors: Array<{
    tipCursor: IndexerCursor;
    backfillCursor: IndexerCursor;
    etags: { nodes?: string | null };
  }> = [];
  // Aliased as `cursor` so existing test assertions that pre-date the two-cursor
  // split keep reading the tip position — the pre-refactor single cursor WAS
  // the tip cursor.
  cursor: IndexerCursor = { epoch: null, blockIndex: 0 };
  backfillCursor: IndexerCursor = { epoch: null, blockIndex: 0 };
  etags: { nodes: string | null } = { nodes: null };
  meta: Map<string, string> = new Map();
  selfAddress: string | null = null;
  epochStatus: EpochStatusEntry[] = [];

  async connect() {
    this.connected = true;
  }
  async disconnect() {
    this.connected = false;
  }
  async migrate() {
    this.migrated = true;
  }

  async insertBlock(b: BlockRecord): Promise<boolean> {
    this.inserted.push(b);
    return true;
  }
  async getAllBlocks(): Promise<BlockRecord[]> {
    return [...this.inserted];
  }
  async getBlocksByEpoch(epoch: string): Promise<BlockRecord[]> {
    return this.inserted.filter((b) => b.epoch === epoch);
  }
  async getIndex(): Promise<TelemetryIndex> {
    return { epochs: [], lastUpdated: new Date().toISOString() };
  }
  async replaceEpochStatus(entries: EpochStatusEntry[]): Promise<void> {
    this.epochStatus = [...entries];
  }

  async upsertNodes(snapshot: NodesSnapshot): Promise<number> {
    this.upserted.push(snapshot);
    return Object.keys(snapshot.nodes).length;
  }
  async getNodes(): Promise<NodesSnapshot | null> {
    return this.upserted.at(-1) ?? null;
  }

  async getCursors(): Promise<{ tip: IndexerCursor; backfill: IndexerCursor }> {
    return { tip: { ...this.cursor }, backfill: { ...this.backfillCursor } };
  }
  async saveCursors(
    tip: IndexerCursor,
    backfill: IndexerCursor,
    etags: { nodes?: string | null },
  ): Promise<void> {
    this.savedCursors.push({
      tipCursor: { ...tip },
      backfillCursor: { ...backfill },
      etags: { ...etags },
    });
    this.cursor = { ...tip };
    this.backfillCursor = { ...backfill };
    if (etags.nodes !== undefined) this.etags.nodes = etags.nodes ?? null;
  }
  async getEtags() {
    return { ...this.etags };
  }
  async setMetaRaw(key: string, value: string): Promise<void> {
    this.meta.set(key, value);
  }

  async getSelfAddress(): Promise<string | null> {
    return this.selfAddress;
  }
  async setSelfAddress(address: string | null): Promise<void> {
    this.selfAddress = address;
  }

  observability: IndexerObservability | null = null;
  observabilityWrites: IndexerObservability[] = [];
  async getIndexerObservability(): Promise<IndexerObservability | null> {
    return this.observability;
  }
  async setIndexerObservability(obs: IndexerObservability): Promise<void> {
    this.observability = obs;
    this.observabilityWrites.push(obs);
  }

  // v5 substrate-derived state. Stub storage; tests that exercise substrate
  // behavior assert against these fields directly.
  chainHead: ChainHead | null = null;
  babeEpochs: Map<number, BabeEpochState> = new Map();
  currentBabeEpochIndex: number | null = null;
  babeAuthorities: Map<string, BabeAuthorityRecord & { isActive: boolean }> = new Map();
  chainMiners: Map<string, Omit<ChainMinerRecord, "telemetryNodeAddress">> = new Map();
  difficultyHistory: DifficultyRecord[] = [];
  substrateFieldUpdates: Array<{
    epoch: EpochId;
    blockIndex: number;
    fields: Record<string, unknown>;
  }> = [];

  async upsertChainHead(head: ChainHead): Promise<void> {
    this.chainHead = head;
  }
  async getChainHead(): Promise<ChainHead | null> {
    return this.chainHead;
  }
  async upsertBabeEpoch(epoch: BabeEpochState): Promise<void> {
    this.babeEpochs.set(epoch.epochIndex, epoch);
    this.currentBabeEpochIndex = epoch.epochIndex;
  }
  async getCurrentBabeEpoch(): Promise<BabeEpochState | null> {
    if (this.currentBabeEpochIndex == null) return null;
    return this.babeEpochs.get(this.currentBabeEpochIndex) ?? null;
  }
  async upsertBabeAuthorities(_epochIndex: number, authorities: BabeAuthorityRecord[]): Promise<void> {
    const incoming = new Set(authorities.map((a) => a.accountId));
    for (const [id, prev] of this.babeAuthorities) {
      if (!incoming.has(id)) prev.isActive = false;
    }
    for (const a of authorities) {
      this.babeAuthorities.set(a.accountId, { ...a, isActive: true });
    }
  }
  async getActiveBabeAuthorities(): Promise<BabeAuthorityRecord[]> {
    return [...this.babeAuthorities.values()]
      .filter((a) => a.isActive)
      .map(({ accountId, displayName }) => ({ accountId, displayName }));
  }
  async upsertChainMiners(
    miners: Array<Omit<ChainMinerRecord, "telemetryNodeAddress">>,
  ): Promise<void> {
    for (const m of miners) this.chainMiners.set(m.accountId, m);
  }
  async getChainMiners(): Promise<Array<Omit<ChainMinerRecord, "telemetryNodeAddress">>> {
    return [...this.chainMiners.values()].sort(
      (a, b) => Number(b.rewardsEarned) - Number(a.rewardsEarned),
    );
  }
  async insertDifficultySnapshot(snapshot: DifficultyRecord): Promise<void> {
    if (!this.difficultyHistory.some((d) => d.observedAtBlock === snapshot.observedAtBlock)) {
      this.difficultyHistory.push(snapshot);
    }
  }
  async getRecentDifficulty(limit: number): Promise<DifficultyRecord[]> {
    return [...this.difficultyHistory]
      .sort((a, b) => (b.observedAt > a.observedAt ? 1 : -1))
      .slice(0, limit);
  }
  async updateBlockSubstrateFields(
    epoch: EpochId,
    blockIndex: number,
    fields: Partial<{
      substrateBlockNumber: string;
      substrateBlockHash: string;
      substrateParentHash: string;
      extrinsicsRoot: string;
      stateRoot: string;
      finalized: boolean;
    }>,
  ): Promise<{ matched: boolean }> {
    const block = this.inserted.find(
      (b) => b.epoch === epoch && b.blockIndex === blockIndex,
    );
    if (!block) return { matched: false };
    if (fields.substrateBlockNumber !== undefined)
      block.substrateBlockNumber = fields.substrateBlockNumber ?? block.substrateBlockNumber;
    if (fields.substrateBlockHash !== undefined)
      block.substrateBlockHash = fields.substrateBlockHash ?? block.substrateBlockHash;
    if (fields.substrateParentHash !== undefined)
      block.substrateParentHash = fields.substrateParentHash ?? block.substrateParentHash;
    if (fields.extrinsicsRoot !== undefined)
      block.extrinsicsRoot = fields.extrinsicsRoot ?? block.extrinsicsRoot;
    if (fields.stateRoot !== undefined)
      block.stateRoot = fields.stateRoot ?? block.stateRoot;
    if (fields.finalized === true) block.finalized = true;
    this.substrateFieldUpdates.push({ epoch, blockIndex, fields });
    return { matched: true };
  }
  async findBlockByMinerAndEnergy(
    minerId: string,
    energy: number,
  ): Promise<{ epoch: EpochId; blockIndex: number } | null> {
    const matches = this.inserted
      .filter((b) => b.minerId === minerId && b.energy === energy)
      .sort((a, b) => b.timestamp - a.timestamp);
    const m = matches[0];
    if (!m) return null;
    return { epoch: m.epoch, blockIndex: m.blockIndex };
  }
  async markBlocksCanonical(epochs: EpochId[], canonical: boolean): Promise<void> {
    const set = new Set(epochs);
    for (const b of this.inserted) {
      if (set.has(b.epoch)) b.isCanonical = canonical;
    }
  }
  async updateEpochChainAnchor(_epoch: EpochId, _chainAnchor: string): Promise<void> {
    // No-op stub; tests that need this should assert on a different path.
  }
}

export interface FakeResponseSpec {
  status: number;
  etag?: string | null;
  body?: unknown;
  // raw body text that bypasses JSON.stringify (used to inject big-int literals)
  rawText?: string;
}

export type Router = (url: string, init: RequestInit | undefined) => FakeResponseSpec;

export function makeFetch(router: Router): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    let spec = router(url, init);
    // Since the indexer moved to chain-aware attribution, the tip worker
    // fetches /epochs on every poll (used to be only during backfill). Tests that
    // don't care about multi-epoch semantics shouldn't be forced to mock it —
    // synthesize an empty list here and the tip-override in
    // buildCanonicalPlan still yields a valid plan for the single latest epoch.
    if (spec.status === 404 && url.endsWith("/api/v1/telemetry/epochs")) {
      spec = { status: 200, body: { epochs: [] } };
    }
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
    // jsdom/undici responses normally expose url, but fetch()'s Response
    // doesn't carry it; we stash it so error messages in the client show
    // something useful. Not strictly required for tests.
    Object.defineProperty(res, "url", { value: url, configurable: true });
    return res;
  };
  return fn as typeof fetch;
}

export function makeConfig(overrides: Partial<IndexerConfig> = {}): IndexerConfig {
  return {
    nodeUrl: "https://node.example.com",
    token: undefined,
    pollIntervalSec: 8,
    nodesRefreshSec: 45,
    backfillIdleRecheckSec: 300,
    once: false,
    verbose: false,
    stallWarnAfterSec: 600,
    substrateRpcUrl: null,
    substrateRpcTimeoutMs: 15000,
    substrateReconnectMaxBackoffMs: 60000,
    substrateBabePollSec: 30,
    substrateChainPollSec: 300,
    ...overrides,
  };
}

export function buildBlockPayload(
  _epoch: string,
  index: number,
  nonce: number | string = 123,
  // Defaults to a chain-id-invariant hash so multiple epochs in the same
  // test share a common block_1 hash and are treated as the same canonical
  // chain. Tests that exercise fork behavior pass an explicit chainId.
  chainId: string = "canonical",
): Record<string, unknown> {
  return {
    block_index: index,
    block_hash: `hash-${chainId}-${index}`,
    timestamp: 1_700_000_000 + index,
    previous_hash: `prev-${index}`,
    miner: {
      miner_id: "miner-a",
      miner_type: "QPU",
      ecdsa_public_key: "pk",
    },
    quantum_proof: {
      energy: -1.5,
      diversity: 0.5,
      num_valid_solutions: 2,
      mining_time: 3.14,
      nonce,
      num_nodes: 4,
      num_edges: 5,
    },
    requirements: {
      difficulty_energy: -2.0,
      min_diversity: 0.1,
      min_solutions: 1,
    },
  };
}

export function statusBody(
  latestEpoch: string,
  latestBlockIndex: number,
  totalBlocks = latestBlockIndex,
): Record<string, unknown> {
  return {
    epochs: [latestEpoch],
    latest_epoch: latestEpoch,
    latest_block_index: latestBlockIndex,
    total_blocks: totalBlocks,
    node_count: 0,
    active_node_count: 0,
    nodes_updated_at: null,
  };
}
