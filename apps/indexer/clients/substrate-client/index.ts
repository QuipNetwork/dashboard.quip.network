// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SubstrateClient interface: thin abstraction over the substrate RPC the
// indexer needs from `quip-protocol-rs` (BABE consensus + Grandpa finality
// + custom `pallet-quantum-pow`). The production impl
// (PolkadotSubstrateClient, this file) wraps `@polkadot/api`; the test
// impl (FakeSubstrateClient) is a programmable in-memory stand-in.
//
// Bundle isolation: `@polkadot/*` is imported only here. Anything in src/
// must never reach for substrate state directly — the worker pipes results
// through the indexer state and DB, and the SPA reads them via the server's
// /api/telemetry payload.

import { ApiPromise, WsProvider } from "@polkadot/api";
import { GenericExtrinsicSignatureV4 } from "@polkadot/types/extrinsic/v4/ExtrinsicSignature";
import { GenericExtrinsicSignatureV5 } from "@polkadot/types/extrinsic/v5/ExtrinsicSignature";
import type { RegistryTypes } from "@polkadot/types/types";

import type {
  MinerCategory,
  NodeDescriptor,
  NodeMinerEntry,
  NodeRuntime,
  NodeSystemCpu,
  NodeSystemGpu,
  NodeSystemInfo,
  NodeSystemOs,
} from "@quip/shared/telemetry";

import type {
  BabeAuthorityInfo,
  BabeEpochInfo,
  BlockEvents,
  BlockWinnerEvent,
  ChainMinerInfo,
  DifficultyInfo,
  MineableTopologyInfo,
  MinerRegistryDescriptorRecord,
  ProofAcceptedEvent,
  RuntimeVersionInfo,
  SubstrateClient,
  SubstrateHead,
  SyncStateInfo,
  TopologyInfo,
  UnsubFn,
  QBlockInfo,
} from "./types";

export * from "./types";
export { FakeSubstrateClient } from "./fake";
export { StatePrunedError, isStateDiscardedError } from "./errors";

import { isStateDiscardedError, mapPruned } from "./errors";

// quip-protocol-rs replaces stock `MultiSignature` with `HybridTxSignature`
// (a plain `{public: [u8;1344], signature: [u8;2484]}` struct — see
// quip-protocol-rs/crates/transaction-crypto/src/lib.rs). The chain's V16
// metadata exposes the type at `quip_transaction_crypto::HybridTxSignature`
// (type id 106 on spec 101) and polkadot.js auto-resolves
// `ExtrinsicSignature` to it via the metadata lookup. We do NOT need to
// register the type ourselves.
//
// However: polkadot.js v16.5.6's `GenericExtrinsicSignatureV{4,5}` computes
// `isSigned` from `!this.signature.isEmpty`, which only works for the stock
// `MultiSignature` enum (empty bytes → no variant → isEmpty=true). For our
// concrete (non-enum) struct signature, default bytes are 1344+2484 zeros
// — non-empty — so isSigned is incorrectly always true. That cascades into
// `GenericExtrinsic.version` throwing "Signed Extrinsics are currently only
// available for ExtrinsicV4" even for V5 *unsigned* timestamp inherents.
//
// The fix: subclass the V4/V5 signature codecs and track `isSigned` from
// the constructor option (which polkadot.js sets correctly from the
// extrinsic's preamble byte) instead of inferring it from field bytes.
class HybridExtrinsicSignatureV4 extends GenericExtrinsicSignatureV4 {
  #isExplicitlySigned: boolean;
  // The base class' constructor signature uses positional args we forward
  // as-is; the third arg is `{ isSigned }`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(registry: any, value: unknown, opts: { isSigned?: boolean } = {}) {
    super(registry, value as never, opts as never);
    this.#isExplicitlySigned = Boolean(opts.isSigned);
  }
  override get isSigned(): boolean {
    return this.#isExplicitlySigned;
  }
}

class HybridExtrinsicSignatureV5 extends GenericExtrinsicSignatureV5 {
  #isExplicitlySigned: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(registry: any, value: unknown, opts: { isSigned?: boolean } = {}) {
    super(registry, value as never, opts as never);
    this.#isExplicitlySigned = Boolean(opts.isSigned);
  }
  override get isSigned(): boolean {
    return this.#isExplicitlySigned;
  }
}

// MUST go through ApiPromise.create's `types` option, never a post-create
// api.registry.register() call: polkadot.js swaps registries per block hash
// (base/Init.js setRegistrySwap) and builds a FRESH registry for any block
// from an older runtime specVersion. Each new registry is seeded only from
// the create() options (knownTypes.types is getSpecTypes' final catch-all
// override), so options are the one channel that reaches the per-block
// registries used when backfilling pre-upgrade blocks. The values are Codec
// classes, which RegistryTypes' type doesn't admit even though register()
// handles them at runtime — hence the cast.
export const HYBRID_EXTRINSIC_TYPES = {
  ExtrinsicSignatureV4: HybridExtrinsicSignatureV4,
  ExtrinsicSignatureV5: HybridExtrinsicSignatureV5,
} as unknown as RegistryTypes;

/**
 * @polkadot/api-backed implementation. Pinned to 16.5.6 in package.json so
 * @polkadot/types stays in lockstep (a mismatch produces opaque decode
 * errors). Storage queries target quip-protocol-rs v0.2 — later runtime
 * upgrades may rename items; capability checks (`?.`) keep the worker
 * non-fatal in that case.
 */
export class PolkadotSubstrateClient implements SubstrateClient {
  private api: ApiPromise | null = null;
  private provider: WsProvider | null = null;
  private connectedCbs = new Set<() => void>();
  private disconnectedCbs = new Set<() => void>();

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number = 15_000,
  ) {}

  async connect(): Promise<void> {
    // autoConnect = false: our substrate-worker owns the reconnect loop
    // (exponential backoff with jitter). WsProvider's built-in reconnect
    // uses a fixed interval which doesn't match our policy. WITH
    // autoConnect=false, the constructor does NOT initiate the socket —
    // we must call provider.connect() ourselves, otherwise ApiPromise.create
    // waits forever for a "connected" event that never fires.
    this.provider = new WsProvider(this.url, false, undefined, this.timeoutMs);
    this.provider.on("connected", () => {
      for (const cb of this.connectedCbs) cb();
    });
    this.provider.on("disconnected", () => {
      for (const cb of this.disconnectedCbs) cb();
    });
    await this.provider.connect();
    // `types` overrides the extrinsic signature codecs so polkadot.js v16's
    // `isSigned` derivation works with quip's `HybridTxSignature` struct —
    // on the boot registry AND on the per-block registries created for
    // historical specVersions. See HYBRID_EXTRINSIC_TYPES above.
    this.api = await ApiPromise.create({
      provider: this.provider,
      throwOnConnect: true,
      types: HYBRID_EXTRINSIC_TYPES,
    });
  }

  async disconnect(): Promise<void> {
    const api = this.api;
    this.api = null;
    this.provider = null;
    if (api) await api.disconnect();
  }

  isConnected(): boolean {
    return this.provider?.isConnected ?? false;
  }

  async getSyncState(): Promise<SyncStateInfo> {
    const api = this.requireApi();
    const health = await api.rpc.system.health();
    let currentBlock: number | null = null;
    let highestBlock: number | null = null;
    try {
      const sync = await api.rpc.system.syncState();
      currentBlock = sync.currentBlock.toNumber();
      // highestBlock is Option<BlockNumber> on current node versions.
      highestBlock = sync.highestBlock.isSome ? sync.highestBlock.unwrap().toNumber() : null;
    } catch {
      // system_syncState absent on this node; system_health alone still
      // drives the gate.
    }
    return {
      isSyncing: health.isSyncing.isTrue,
      peers: health.peers.toNumber(),
      currentBlock,
      highestBlock,
    };
  }

  onConnected(cb: () => void): UnsubFn {
    this.connectedCbs.add(cb);
    return () => {
      this.connectedCbs.delete(cb);
    };
  }
  onDisconnected(cb: () => void): UnsubFn {
    this.disconnectedCbs.add(cb);
    return () => {
      this.disconnectedCbs.delete(cb);
    };
  }

  private requireApi(): ApiPromise {
    if (!this.api) throw new Error("[substrate-client] not connected");
    return this.api;
  }

  async subscribeFinalizedHeads(cb: (h: SubstrateHead) => void): Promise<UnsubFn> {
    const api = this.requireApi();
    const unsub = await api.rpc.chain.subscribeFinalizedHeads((header) => {
      cb({
        number: header.number.toString(),
        hash: header.hash.toHex(),
        parentHash: header.parentHash.toHex(),
        extrinsicsRoot: header.extrinsicsRoot.toHex(),
        stateRoot: header.stateRoot.toHex(),
      });
    });
    return () => {
      unsub();
    };
  }

  async subscribeNewHeads(cb: (h: SubstrateHead) => void): Promise<UnsubFn> {
    const api = this.requireApi();
    const unsub = await api.rpc.chain.subscribeNewHeads((header) => {
      cb({
        number: header.number.toString(),
        hash: header.hash.toHex(),
        parentHash: header.parentHash.toHex(),
        extrinsicsRoot: header.extrinsicsRoot.toHex(),
        stateRoot: header.stateRoot.toHex(),
      });
    });
    return () => {
      unsub();
    };
  }

  async subscribeBlockWinnerEvents(cb: (e: BlockWinnerEvent) => void): Promise<UnsubFn> {
    const api = this.requireApi();
    const eventsQuery = api.query.system?.events;
    if (!eventsQuery) {
      // `system.events` is a baseline substrate capability — if it's gone,
      // the chain is so broken (or the api client so misconfigured) that
      // silently returning a no-op unsub would hide it forever. Throw so
      // the reconnect loop logs + backs off; the operator can then see
      // that block-winner attribution is unwired.
      throw new Error(
        "[substrate-client] api.query.system.events is unavailable; cannot subscribe to BlockWinner events",
      );
    }
    // Subscribes to ALL events; filter to quantumPow.BlockWinner. Event
    // shape (v0.2): (qblock_id: u64, block_number: BlockNumber, miner:
    // AccountId, reward: Balance, energy_milli: i64, submitted_at:
    // BlockNumber). Positional decode lives in `decodeBlockWinnerEventData`.
    type EventRecord = {
      event: {
        section: string;
        method: string;
        data: Array<{ toString: () => string }>;
      };
    };
    const unsub = await eventsQuery((records: EventRecord[]) => {
      for (const record of records) {
        const { event } = record;
        if (event.section !== "quantumPow" || event.method !== "BlockWinner") continue;
        const decoded = decodeBlockWinnerEventData(event.data);
        if (decoded) cb(decoded);
      }
    });
    return () => {
      (unsub as unknown as () => void)();
    };
  }

  async getBabeEpoch(): Promise<BabeEpochInfo | null> {
    const api = this.requireApi();
    if (!api.query.babe?.epochIndex || !api.query.babe?.currentSlot) return null;
    const [epochIndexCodec, currentSlotCodec] = await Promise.all([
      api.query.babe.epochIndex(),
      api.query.babe.currentSlot(),
    ]);
    const slotsPerEpochConst = api.consts.babe?.epochDuration;
    if (!slotsPerEpochConst) return null;
    const slotsPerEpoch = Number(slotsPerEpochConst.toString());
    const epochIndex = Number(epochIndexCodec.toString());
    const currentSlot = currentSlotCodec.toString();
    // epoch_start_slot is not directly exposed by stock BABE; derive from
    // epoch_index * slots_per_epoch which is exact when no epoch was skipped.
    const epochStartSlot = (BigInt(epochIndex) * BigInt(slotsPerEpoch)).toString();
    const authorityCount = (await this.getBabeAuthorities()).length;
    return { epochIndex, currentSlot, epochStartSlot, slotsPerEpoch, authorityCount };
  }

  async getBabeAuthorities(): Promise<BabeAuthorityInfo[]> {
    const api = this.requireApi();
    // `session.validators` is the only authoritative source: it returns the
    // full hybrid AccountIds that join against `quantumPow.miners` and
    // `validator_authorship`. The legacy `babe.authorities` fallback returned
    // the 1344-byte BABE pubkey instead, which doesn't join — keeping it
    // around just made the Chain tab appear non-empty against the wrong
    // identifiers. Throw loudly so a misconfigured chain surfaces in indexer
    // logs immediately.
    if (!api.query.session?.validators) {
      throw new Error(
        "[substrate-client] api.query.session.validators is unavailable; " +
          "indexer requires quip-protocol-rs >= v0.2 (pallet-session integrated).",
      );
    }
    const codec = await api.query.session.validators();
    const list = codec as unknown as Array<{ toString: () => string }>;
    return list.map((id) => ({ accountId: id.toString(), displayName: null }));
  }

  async getChainMiners(): Promise<ChainMinerInfo[]> {
    const api = this.requireApi();
    if (!api.query.quantumPow?.miners) return [];
    const entries = await api.query.quantumPow.miners.entries();
    const out: ChainMinerInfo[] = [];
    for (const [key, value] of entries) {
      const accountId = key.args[0]!.toString();
      // MinerInfo struct from pallet-quantum-pow/src/types.rs:57-67.
      // polkadot.js exposes Rust field names in camelCase via codec.toJSON;
      // we read via toHuman/toJSON for reliable field access.
      const json = (value as unknown as { toJSON: () => Record<string, unknown> }).toJSON();
      out.push({
        accountId,
        deposit: String(json.deposit ?? "0"),
        proofsSubmitted: String(json.proofsSubmitted ?? json.proofs_submitted ?? "0"),
        proofsWon: String(json.proofsWon ?? json.proofs_won ?? "0"),
        rewardsEarned: String(json.rewardsEarned ?? json.rewards_earned ?? "0"),
      });
    }
    return out;
  }

  async getDifficulty(): Promise<DifficultyInfo | null> {
    const api = this.requireApi();
    // Prefer the v0.2 runtime API: it applies on-the-fly decay so the
    // returned value reflects the threshold the pallet actually checks
    // proofs against (not the stored baseline, which only refreshes on
    // sudo updates and can be hours stale through a decay window).
    const runtimeFn = (api.call as unknown as Record<string, Record<string, unknown> | undefined>)
      ?.quantumPowApi?.currentDifficulty;
    if (typeof runtimeFn === "function") {
      const codec = await (runtimeFn as () => Promise<unknown>)();
      return decodeDifficulty(codec);
    }
    // Capability fallback for pre-v0.2 chains. Drop in a follow-up MR
    // once the deployed chain is stable on the new runtime API.
    if (!api.query.quantumPow?.difficulty) return null;
    const codec = await api.query.quantumPow.difficulty();
    return decodeDifficulty(codec);
  }

  async getMineableTopologies(): Promise<MineableTopologyInfo[]> {
    const api = this.requireApi();
    const call = api.call as unknown as Record<string, Record<string, unknown> | undefined>;
    const listFn = call?.quantumPowApi?.mineableTopologies;
    if (typeof listFn !== "function") return []; // pre-v0.2 runtime
    const listCodec = await (listFn as () => Promise<unknown>)();
    const hashes = (listCodec as { toJSON?: () => unknown }).toJSON?.();
    if (!Array.isArray(hashes)) return [];

    // Resolve the default topology hash so each entry can be flagged.
    let defaultHash: string | null = null;
    const dt = api.query.quantumPow?.defaultTopology;
    if (dt) {
      const opt = (await dt()) as { isSome?: boolean; unwrap?: () => { toHex: () => string } };
      if (opt?.isSome && opt.unwrap) defaultHash = opt.unwrap().toHex();
    }

    const diffFn = call?.quantumPowApi?.difficultyFor;
    const metaFn = call?.quantumPowApi?.topologyMeta;
    const out: MineableTopologyInfo[] = [];
    for (const raw of hashes) {
      const topologyHash = String(raw);
      let difficulty: DifficultyInfo = {
        maxEnergyMilli: 0,
        minDiversityMilli: 0,
        minSolutions: 0,
      };
      if (typeof diffFn === "function") {
        const dc = (await (diffFn as (h: string) => Promise<unknown>)(topologyHash)) as {
          isSome?: boolean;
          unwrap?: () => unknown;
        };
        if (dc?.isSome && dc.unwrap) difficulty = decodeDifficulty(dc.unwrap());
      }
      let nodeCount = 0;
      let edgeCount = 0;
      let curveConstant: number | null = null;
      if (typeof metaFn === "function") {
        const mc = (await (metaFn as (h: string) => Promise<unknown>)(topologyHash)) as {
          isSome?: boolean;
          unwrap?: () => {
            nodes: { length: number };
            edges: { length: number };
            // The allowed-value specs are small enums; toJSON only these (never
            // the large nodes/edges vectors) to keep the poll cheap.
            allowedHValues?: { toJSON?: () => unknown };
            allowedJValues?: { toJSON?: () => unknown };
            allowed_h_values?: { toJSON?: () => unknown };
            allowed_j_values?: { toJSON?: () => unknown };
          };
        };
        if (mc?.isSome && mc.unwrap) {
          const meta = mc.unwrap();
          nodeCount = meta.nodes.length;
          edgeCount = meta.edges.length;
          const hSpec = (meta.allowedHValues ?? meta.allowed_h_values)?.toJSON?.();
          const jSpec = (meta.allowedJValues ?? meta.allowed_j_values)?.toJSON?.();
          curveConstant = computeCurveConstant(nodeCount, edgeCount, hSpec, jSpec);
        }
      }
      out.push({
        topologyHash,
        isDefault: topologyHash === defaultHash,
        difficulty,
        nodeCount,
        edgeCount,
        curveConstant,
      });
    }
    return out;
  }

  async getQBlockParticipantCount(qblockId: string): Promise<number | null> {
    const api = this.requireApi();
    const fn = (api.call as unknown as Record<string, Record<string, unknown> | undefined>)
      ?.minerRegistryApi?.participantCountByQblock;
    if (typeof fn !== "function") return null; // pre-v0.2 / pallet absent
    const codec = await (fn as (id: string) => Promise<unknown>)(qblockId);
    const n = Number((codec as { toString: () => string }).toString());
    return Number.isFinite(n) ? n : null;
  }

  async getRuntimeVersion(): Promise<RuntimeVersionInfo> {
    const api = this.requireApi();
    const rv = api.runtimeVersion;
    return {
      specName: rv.specName.toString(),
      specVersion: rv.specVersion.toNumber(),
      transactionVersion: rv.transactionVersion.toNumber(),
      implName: rv.implName.toString(),
    };
  }

  async getLastRuntimeUpgrade(): Promise<{ blockNumber: string } | null> {
    const api = this.requireApi();
    if (!api.query.system?.lastRuntimeUpgrade) return null;
    const codec = await api.query.system.lastRuntimeUpgrade();
    const opt = codec as unknown as {
      isSome?: boolean;
      unwrap?: () => Record<string, { toString: () => string }>;
    };
    if (!opt.isSome || !opt.unwrap) return null;
    const inner = opt.unwrap();
    // lastRuntimeUpgrade is `Option<LastRuntimeUpgradeInfo>` with
    // {spec_version, spec_name}. We want the block number it happened at —
    // which isn't actually in this storage; the storage tells you what
    // version was installed, not when. Surface specVersion in lieu of
    // blockNumber; the substrate worker uses it as an upgrade-trigger
    // sentinel, not a block reference.
    return { blockNumber: String(inner.specVersion?.toString() ?? "0") };
  }

  async getBlockHeader(blockNumber: string): Promise<SubstrateHead | null> {
    const api = this.requireApi();
    const hashCodec = await api.rpc.chain.getBlockHash(blockNumber);
    if (hashCodec.isEmpty) return null;
    const signed = await api.rpc.chain.getBlock(hashCodec);
    const header = signed.block.header;
    return {
      number: header.number.toString(),
      hash: header.hash.toHex(),
      parentHash: header.parentHash.toHex(),
      extrinsicsRoot: header.extrinsicsRoot.toHex(),
      stateRoot: header.stateRoot.toHex(),
    };
  }

  async getQBlock(blockNumber: string): Promise<QBlockInfo | null> {
    const api = this.requireApi();
    const fn = (api.call as unknown as Record<string, Record<string, unknown> | undefined>)
      ?.quantumPowApi?.winningSolution;
    if (typeof fn !== "function") return null;
    const codec = await (fn as (n: string) => Promise<unknown>)(blockNumber);
    // WinningSolutionWithNonce is `Option<{solution: WinningSolution, nonce: U256}>`.
    const opt = codec as {
      isSome?: boolean;
      unwrap?: () => Record<string, unknown>;
    };
    if (!opt.isSome || !opt.unwrap) return null;
    const wrapped = opt.unwrap();
    const solRaw = wrapped.solution ?? wrapped["solution"];
    if (!solRaw) return null;
    // polkadot.js may surface struct fields as codec instances; coerce via
    // toJSON for the primitive view we need.
    const sol =
      typeof (solRaw as { toJSON?: () => unknown }).toJSON === "function"
        ? ((solRaw as { toJSON: () => Record<string, unknown> }).toJSON() as Record<
            string,
            unknown
          >)
        : (solRaw as Record<string, unknown>);
    const nonceCodec = wrapped.nonce;
    const nonce =
      typeof (nonceCodec as { toString?: () => string })?.toString === "function"
        ? (nonceCodec as { toString: () => string }).toString()
        : String(nonceCodec ?? "0");
    return qblockInfoFromSolution(sol, nonce);
  }

  async subscribeBlockEvents(cb: (e: BlockEvents) => void): Promise<UnsubFn> {
    const api = this.requireApi();
    // Finalized-only subscription via the bare `api.rpc.chain.subscribeFinalizedHeads`.
    // We previously used `api.derive.chain.subscribeFinalizedHeads` (which gap-fills
    // skipped heads when finalization jumps ahead), but its callback was
    // silently never invoked against quip-protocol-rs v0.2 chains — finalizedBlockHeight
    // updated fine via the bare RPC subscription, but the derive wrapper
    // ate every head. The bare subscription is what every other path in this
    // file already uses; per-block enrichment (author + events) still happens
    // via `derive.chain.getBlock(hash)` inside the callback through
    // `decodeFinalizedBlock`, so the eventual shape is unchanged.
    const unsubFn = await api.rpc.chain.subscribeFinalizedHeads(async (header) => {
      try {
        const events = await this.decodeFinalizedBlock(
          header.hash.toHex(),
          header.parentHash.toHex(),
          header.number.toNumber(),
        );
        if (events) cb(events);
      } catch (e) {
        // Contain per-block failures so a transient RPC blip (getBlock
        // timeout, decode mishap, downstream cb throw) doesn't let the
        // rejection escape into polkadot.js — which is version-dependent
        // and in the worst case silently degrades the subscription. The
        // next finalized head fires normally.
        const num = header.number.toNumber();
        console.warn(`[substrate-client] subscribeBlockEvents block ${num} failed`, e);
      }
    });
    return () => {
      (unsubFn as unknown as () => void)();
    };
  }

  async getQBlockNumbers(): Promise<string[]> {
    const api = this.requireApi();
    // v0.2 renamed the winning-solution storage: WinningSolutions → QBlocks
    // (StorageMap keyed by substrate block number). Capability check covers
    // pre-v0.2 chains where neither item exists.
    const qBlocks = api.query.quantumPow?.qBlocks;
    if (!qBlocks) return [];
    // Paged KEYS, not entries(): entries fetches every WinningSolution value
    // just to discard it — O(total winners × value size) of RPC payload that
    // the reconciler would pay hourly (spec §5). Keys are a few hundred KB.
    type PagedKey = { args: Array<{ toString: () => string }>; toHex: () => string };
    const keysPaged = (
      qBlocks as unknown as {
        keysPaged?: (opts: {
          args: unknown[];
          pageSize: number;
          startKey?: string;
        }) => Promise<PagedKey[]>;
      }
    ).keysPaged;
    if (typeof keysPaged !== "function") {
      // Very old polkadot.js fallback — keys() is still values-free.
      if (!qBlocks.keys) return [];
      const keys = (await qBlocks.keys()) as unknown as PagedKey[];
      return keys.map((k) => k.args[0]!.toString());
    }
    const out: string[] = [];
    let startKey: string | undefined;
    for (;;) {
      const page = await keysPaged.call(qBlocks, { args: [], pageSize: 1000, startKey });
      if (page.length === 0) break;
      for (const k of page) out.push(k.args[0]!.toString());
      startKey = page[page.length - 1]!.toHex();
      if (page.length < 1000) break;
    }
    return out;
  }

  async getQBlockCount(): Promise<number | null> {
    const api = this.requireApi();
    const q = api.query.quantumPow;
    if (!q) return null;
    // v0.2 exposes `QBlockCount` (u64 ValueQuery) — the network-wide count of
    // winning qblocks, i.e. the global "solution number". Prefer it: a single
    // O(1) storage read instead of scanning every QBlocks key. (Replaces the
    // v0.1 WinningSolutions map + its CountedStorageMap companion.)
    const countFn = (q as Record<string, unknown>)["qBlockCount"] as
      | { (): Promise<{ toString: () => string }> }
      | undefined;
    if (typeof countFn === "function") {
      const raw = await countFn();
      const n = Number(raw.toString());
      if (Number.isFinite(n)) return n;
    }
    // Fallback: count QBlocks keys (one paged scan). Null on pre-v0.2 chains
    // where neither QBlockCount nor QBlocks exists.
    if (!q.qBlocks?.keys) return null;
    const keys = (await q.qBlocks.keys()) as unknown as unknown[];
    return keys.length;
  }

  async processFinalizedBlock(blockNumber: string): Promise<BlockEvents | null> {
    const api = this.requireApi();
    const hashCodec = await api.rpc.chain.getBlockHash(blockNumber);
    const blockHash = hashCodec.toHex();
    // BlockHash("0x00…00") is the chain_getBlockHash sentinel for
    // "block not found"; nothing to decode.
    if (/^0x0+$/.test(blockHash)) return null;
    const header = await api.rpc.chain.getHeader(hashCodec);
    return this.decodeFinalizedBlock(blockHash, header.parentHash.toHex(), Number(blockNumber));
  }

  // Shared decoder for both live finalized heads (via subscribe) and
  // historical backfill blocks (via processFinalizedBlock). Pulls
  // SignedBlockExtended (author + events + extrinsics) plus the block's
  // timestamp inherent, parses out BlockWinner / ProofAccepted events, and
  // resolves the winner's nonce via the v0.2 runtime API. Throws on RPC
  // failures so the caller can decide how to surface them.
  private async decodeFinalizedBlock(
    blockHash: string,
    parentHash: string,
    blockNumber: number,
  ): Promise<BlockEvents | null> {
    const api = this.requireApi();
    const timestampAt = api.query.timestamp?.now?.at;
    if (!timestampAt) {
      throw new Error("[substrate-client] runtime missing timestamp.now");
    }
    if (!api.derive.chain?.getBlock) {
      throw new Error("[substrate-client] api.derive.chain.getBlock is unavailable");
    }
    // Tier-2 reads (state at the historical hash): pruned nodes surface
    // "state already discarded" here — typed so the dispatcher can ratchet
    // per-plugin pruned floors instead of gap-retrying forever (spec §8.3).
    const [signedBlockExt, timestampAtBlock] = await Promise.all([
      api.derive.chain.getBlock(blockHash),
      timestampAt(blockHash),
    ]).catch(mapPruned);
    const author = signedBlockExt.author ? signedBlockExt.author.toString() : null;

    type EventRecord = {
      event: {
        section: string;
        method: string;
        data: Array<{ toString: () => string }>;
      };
    };
    let winner: BlockWinnerEvent | null = null;
    const proofs: ProofAcceptedEvent[] = [];
    for (const rec of signedBlockExt.events as unknown as EventRecord[]) {
      const { section, method, data } = rec.event;
      if (section !== "quantumPow") continue;
      if (method === "BlockWinner") {
        const decoded = decodeBlockWinnerEventData(data);
        if (decoded) winner = decoded;
      } else if (method === "ProofAccepted") {
        const [minerCodec, energyCodec, diversityCodec, validCodec] = data;
        if (!minerCodec || !energyCodec || !diversityCodec || !validCodec) continue;
        proofs.push({
          miner: minerCodec.toString(),
          energyMilli: Number(energyCodec.toString()),
          diversityMilli: Number(diversityCodec.toString()),
          validSolutionCount: Number(validCodec.toString()),
        });
      }
    }
    // Nonce sourced from quip-protocol-rs v0.2's
    // `QuantumPowApi::winning_solution(block)` — the runtime computes the
    // BLAKE3 digest server-side. Null for winnerless heads (no fetch
    // performed) and for chains pre-v0.2 (capability absent).
    const nonce = winner ? ((await this.getQBlock(String(blockNumber)))?.nonce ?? null) : null;
    return {
      blockNumber,
      blockHash,
      parentHash,
      author,
      // pallet_timestamp returns milliseconds; the indexer stores unix
      // seconds (BlockRecord.timestamp) for parity with the legacy REST
      // path. Truncate rather than round to keep ordering stable.
      timestamp: Math.floor(
        Number((timestampAtBlock as unknown as { toString: () => string }).toString()) / 1000,
      ),
      winner,
      proofs,
      nonce,
    };
  }

  async getLastProofBlockAt(blockHash: string): Promise<number> {
    const api = this.requireApi();
    // Verified storage item: quip-protocol-rs/pallets/quantum-pow/src/lib.rs:129
    // LastProofBlock: StorageValue<_, BlockNumberFor<T>, ValueQuery> → u32/u64.
    if (!api.query.quantumPow?.lastProofBlock) return 0;
    try {
      const codec = await api.query.quantumPow.lastProofBlock.at(blockHash);
      return Number(codec.toString());
    } catch (err) {
      // Tier-2 read: the parent is one block deeper than the block itself,
      // so this can hit pruned state at the boundary (spec §8.2).
      mapPruned(err);
    }
  }

  async getMinerRegistryDescriptorsAt(
    blockNumber: string,
  ): Promise<MinerRegistryDescriptorRecord[] | null> {
    const api = this.requireApi();
    const hashCodec = await api.rpc.chain.getBlockHash(blockNumber);
    const blockHash = hashCodec.toHex();
    if (/^0x0+$/.test(blockHash)) return null;

    const storage = api.query.minerRegistry?.nodeDescriptors as
      | {
          entriesAt?: (hash: unknown) => Promise<Array<[unknown, unknown]>>;
          entries?: () => Promise<Array<[unknown, unknown]>>;
        }
      | undefined;
    if (!storage) return [];

    const entries =
      typeof storage.entriesAt === "function"
        ? await storage.entriesAt(hashCodec)
        : typeof storage.entries === "function"
          ? await storage.entries()
          : [];

    const metaCache = new Map<
      string,
      Promise<{ blockHash: string; blockTimestamp: number } | null>
    >();
    const blockMeta = (updatedAt: string) => {
      let cached = metaCache.get(updatedAt);
      if (!cached) {
        cached = this.getBlockTimestampAndHash(updatedAt);
        metaCache.set(updatedAt, cached);
      }
      return cached;
    };

    const records: MinerRegistryDescriptorRecord[] = [];
    for (const [key, value] of entries) {
      const accountId = decodeStorageKeyAccount(key);
      const decoded = decodeMinerRegistryDescriptor(value);
      if (!accountId || !decoded) continue;
      const meta = await blockMeta(decoded.updatedAt);
      if (!meta) continue;
      records.push({
        accountId,
        blockNumber: decoded.updatedAt,
        blockHash: meta.blockHash,
        blockTimestamp: meta.blockTimestamp,
        descriptor: decoded.descriptor,
      });
    }
    return records;
  }

  // --- firstSeen reconstruction primitives (structurally satisfy
  // descriptor/reconstruct.ts's FirstSeenSource) ---

  async getFinalizedHead(): Promise<string> {
    const api = this.requireApi();
    const hash = await api.rpc.chain.getFinalizedHead();
    const header = await api.rpc.chain.getHeader(hash);
    return header.number.toString();
  }

  async getBlockTimestamp(blockNumber: string): Promise<number> {
    const meta = await this.getBlockTimestampAndHash(blockNumber);
    if (!meta) {
      throw new Error(`[substrate-client] block ${blockNumber} not found on chain`);
    }
    return meta.blockTimestamp;
  }

  async isDescriptorPresentAt(accountId: string, blockNumber: string): Promise<boolean> {
    const api = this.requireApi();
    const hashCodec = await api.rpc.chain.getBlockHash(blockNumber);
    if (/^0x0+$/.test(hashCodec.toHex())) return false;
    const storage = api.query.minerRegistry?.nodeDescriptors as
      | { at?: (hash: unknown, key: unknown) => Promise<unknown> }
      | undefined;
    if (!storage?.at) return false;
    const value = await storage.at(hashCodec, accountId);
    return decodeMinerRegistryDescriptor(value) !== null;
  }

  private async getBlockTimestampAndHash(
    blockNumber: string,
  ): Promise<{ blockHash: string; blockTimestamp: number } | null> {
    const api = this.requireApi();
    const hashCodec = await api.rpc.chain.getBlockHash(blockNumber);
    const blockHash = hashCodec.toHex();
    if (/^0x0+$/.test(blockHash)) return null;
    const timestampAt = api.query.timestamp?.now?.at;
    if (!timestampAt) {
      throw new Error("[substrate-client] runtime missing timestamp.now");
    }
    const timestampCodec = await timestampAt(hashCodec);
    return {
      blockHash,
      blockTimestamp: Math.floor(
        Number((timestampCodec as unknown as { toString: () => string }).toString()) / 1000,
      ),
    };
  }

  async getTopology(): Promise<TopologyInfo | null> {
    const api = this.requireApi();
    // No singleton "RegisteredTopology" exists on the pallet. The chain
    // exposes DefaultTopology: Option<H256> (lib.rs:111) pointing into
    // RegisteredTopologies: StorageMap<H256, TopologyMeta> (lib.rs:107).
    // We materialise (node_count, edge_count) by reading the default
    // topology's TopologyMeta and counting its nodes/edges vectors.
    if (!api.query.quantumPow?.defaultTopology || !api.query.quantumPow?.registeredTopologies) {
      return null;
    }
    const defaultCodec = await api.query.quantumPow.defaultTopology();
    const defaultOpt = defaultCodec as unknown as {
      isSome?: boolean;
      unwrap?: () => { toHex: () => string };
    };
    if (!defaultOpt.isSome || !defaultOpt.unwrap) return null;
    const topologyHash = defaultOpt.unwrap().toHex();
    const metaCodec = await api.query.quantumPow.registeredTopologies(topologyHash);
    const metaOpt = metaCodec as unknown as {
      isSome?: boolean;
      unwrap?: () => { nodes: { length: number }; edges: { length: number } };
    };
    if (!metaOpt.isSome || !metaOpt.unwrap) return null;
    const meta = metaOpt.unwrap();
    return {
      nodeCount: meta.nodes.length,
      edgeCount: meta.edges.length,
    };
  }

  async getDefaultTopologyAt(blockNumber: string): Promise<string | null> {
    const api = this.requireApi();
    const dt = api.query.quantumPow?.defaultTopology as
      | { at?: (hash: string) => Promise<unknown> }
      | undefined;
    if (typeof dt?.at !== "function") return null;
    let blockHash: string;
    try {
      const hashCodec = await api.rpc.chain.getBlockHash(blockNumber);
      blockHash = hashCodec.toHex();
    } catch {
      return null;
    }
    if (/^0x0+$/.test(blockHash)) return null;
    // `DefaultTopology.at(hash)` reads historical state; an archive/deep-pruning
    // node serves it, a shallow-pruning one throws ("state already discarded").
    // Contract (spec §8): pruned state surfaces as a typed StatePrunedError so
    // only THAT case moves the enrichment floor; legitimately-absent values
    // (pre-topology eras) and transient decode failures stay null.
    let codec: unknown;
    try {
      codec = await dt.at(blockHash);
    } catch (err) {
      if (isStateDiscardedError(err)) mapPruned(err);
      return null;
    }
    const opt = codec as { isSome?: boolean; unwrap?: () => { toHex: () => string } };
    if (!opt.isSome || !opt.unwrap) return null;
    return opt.unwrap().toHex();
  }
}

// --- Energy-curve constant (K) -------------------------------------------
//
// Port of `quantum-validation::expected_gse`, which is LINEAR in the per-mille
// curve position `c`: `energy_milli = -c * K`, where
//   K = j_mean_abs * sqrt(2m/n) * n  +  H_ALPHA * h_mean_abs * n / sqrt(2m/n)
// (n = nodes, m = edges; means taken on the unit scale). The dashboard surfaces
// a proof's difficulty as the curve position `‰ = -energy * 1000 / K` instead
// of a raw negative energy, so the chain math lives here and ships one scalar.

const CURVE_H_ALPHA = 0.88; // quantum-validation DEFAULT_H_ALPHA
const CURVE_MILLI_SCALE = 1000; // quantum-validation MILLI_SCALE

/**
 * Compute the energy-curve constant K for a topology. Returns null when the
 * inputs are unusable (no nodes/edges, empty/unknown value specs) so callers
 * degrade gracefully to raw energy.
 */
export function computeCurveConstant(
  nodeCount: number,
  edgeCount: number,
  allowedH: unknown,
  allowedJ: unknown,
): number | null {
  if (nodeCount <= 0 || edgeCount <= 0) return null;
  const hMean = meanAbsUnit(allowedH);
  const jMean = meanAbsUnit(allowedJ);
  if (hMean === null || jMean === null) return null;
  const avgDegree = (2 * edgeCount) / nodeCount;
  const sqrtAvgDegree = Math.sqrt(avgDegree);
  if (!(sqrtAvgDegree > 0)) return null;
  const k = jMean * sqrtAvgDegree * nodeCount + (CURVE_H_ALPHA * hMean * nodeCount) / sqrtAvgDegree;
  return k > 0 ? k : null;
}

// Mean |value| on the unit scale (1.0 == MILLI_SCALE milli) for an
// `AllowedValueSpec` in its `toJSON` form: `{ set: [...] }`,
// `{ integerRange: { min, max } }`, or `{ continuousRange: { min, max } }`.
function meanAbsUnit(spec: unknown): number | null {
  if (!spec || typeof spec !== "object") return null;
  const s = spec as Record<string, unknown>;
  if (Array.isArray(s.set)) {
    const vals = s.set as unknown[];
    if (vals.length === 0) return null;
    const sum = vals.reduce<number>((acc, v) => acc + Math.abs(Number(v)), 0);
    return sum / (vals.length * CURVE_MILLI_SCALE);
  }
  const ir = s.integerRange as { min: number; max: number } | undefined;
  if (ir) return discreteMeanAbs(Number(ir.min), Number(ir.max));
  const cr = s.continuousRange as { min: number; max: number } | undefined;
  if (cr) {
    const d = discreteMeanAbs(Number(cr.min), Number(cr.max));
    return d === null ? null : d / CURVE_MILLI_SCALE;
  }
  return null;
}

// Mean of |k| over integers k in [min, max], via triangular-number sums.
function discreteMeanAbs(min: number, max: number): number | null {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return null;
  const tri = (x: number): number => (x <= 0 ? 0 : (x * (x + 1)) / 2);
  const count = max - min + 1;
  let sumAbs: number;
  if (min >= 0) sumAbs = tri(max) - tri(min - 1);
  else if (max <= 0) sumAbs = tri(-min) - tri(-max - 1);
  else sumAbs = tri(max) + tri(-min);
  return sumAbs / count;
}

// Note: the v0.1-era `extractNonce` helper that walked extrinsics to
// recover the winning miner's nonce is gone in v0.2 — `QBlockInfo`
// (sourced from `QuantumPowApi::winning_solution`) carries the BLAKE3 nonce
// directly, so subscribeBlockEvents calls `getQBlock(...)`
// instead. Less brittle: no dependency on extrinsic decoding or the custom
// HybridTxSignature codec.

/**
 * Map a `toJSON()`-coerced `WinningSolution`/`QBlock` struct + its derived
 * nonce into a {@link QBlockInfo}. Exported so the field mapping (including
 * the spec-111 `device_access_time_us` tail) can be unit-tested without a
 * live chain.
 */
export function qblockInfoFromSolution(sol: Record<string, unknown>, nonce: string): QBlockInfo {
  const rawDevice = sol.deviceAccessTimeUs ?? sol.device_access_time_us;
  const device = Number(rawDevice);
  return {
    miner: String(sol.miner),
    energyMilli: Number(sol.energyMilli ?? sol.energy_milli ?? 0),
    reward: String(sol.reward),
    submittedAt: String(sol.submittedAt ?? sol.submitted_at ?? "0"),
    nonce,
    difficulty: decodeDifficulty(sol.difficulty),
    // null = absent (pre-111) or undecodable; 0 = present-but-unreported.
    deviceAccessTimeUs: rawDevice == null || !Number.isFinite(device) ? null : device,
  };
}

/**
 * Decode a `quantumPow.BlockWinner` event's positional `data` array into a
 * {@link BlockWinnerEvent}. The v0.2 event carries six fields in order:
 * `[qblock_id, block_number, miner, reward, energy_milli, submitted_at]` —
 * two more than the v0.1 shape, which the indexer used to read as `[miner,
 * reward, energy_milli, submitted_at]`. Returns null when the data is
 * truncated (decode anomaly) so callers skip rather than write a misaligned
 * row.
 *
 * Extracted (and exported) so the positional decode can be unit-tested
 * without a live chain — the Fake client emits already-decoded events.
 */
export function decodeBlockWinnerEventData(
  data: Array<{ toString: () => string }>,
): BlockWinnerEvent | null {
  const [qblockIdCodec, blockNumberCodec, minerCodec, rewardCodec, energyCodec, submittedAtCodec] =
    data;
  if (
    !qblockIdCodec ||
    !blockNumberCodec ||
    !minerCodec ||
    !rewardCodec ||
    !energyCodec ||
    !submittedAtCodec
  ) {
    return null;
  }
  return {
    qblockId: qblockIdCodec.toString(),
    blockNumber: blockNumberCodec.toString(),
    miner: minerCodec.toString(),
    reward: rewardCodec.toString(),
    energyMilli: Number(energyCodec.toString()),
    submittedAt: submittedAtCodec.toString(),
  };
}

function decodeStorageKeyAccount(key: unknown): string | null {
  const args = (key as { args?: unknown[] })?.args;
  const first = Array.isArray(args) ? args[0] : undefined;
  if (first !== undefined && first !== null) return String(first);
  const human = (key as { toHuman?: () => unknown })?.toHuman?.();
  if (Array.isArray(human) && human[0] !== undefined && human[0] !== null) return String(human[0]);
  return null;
}

// Exported so the V1/V2 field mapping can be unit-tested without a live
// chain. Accepts a polkadot.js codec (Option<NodeDescriptor>) or, for tests,
// a plain object matching the `.toJSON()` shape. `Bytes` fields arrive as
// 0x-hex and are decoded to UTF-8; `None` options drop out as absent
// optionals. Returns null when the value is absent or carries an
// unsupported schema_version.
export function decodeMinerRegistryDescriptor(
  value: unknown,
): { updatedAt: string; descriptor: NodeDescriptor } | null {
  const unwrapped = unwrapOptionLike(value);
  if (!unwrapped) return null;
  const raw = codecToRecord(unwrapped);
  const schemaVersion = numberFromUnknown(field(raw, "schemaVersion", "schema_version"));
  // v0.2 introduces schema_version 2 (adds `system_info` + `runtime`); the
  // dashboard projects both onto the same v1 NodeDescriptor shape, populating
  // the optional `runtime`/`systemInfo` fields when present.
  if (schemaVersion !== 1 && schemaVersion !== 2) return null;

  const nodeName = stringFromBytes(field(raw, "nodeName", "node_name"));
  if (!nodeName) return null;
  const updatedAt = stringFromNumeric(field(raw, "updatedAt", "updated_at"));
  if (!updatedAt) return null;

  const publicHost = stringFromBytesOption(field(raw, "publicHost", "public_host"));
  const publicPort = numberFromOption(field(raw, "publicPort", "public_port"));
  const rpcEndpoints = stringArrayFromBytes(field(raw, "rpcEndpoints", "rpc_endpoints"));
  const logLevel = enumVariant(field(raw, "logLevel", "log_level"));
  const miners = normalizeRegistryMiners(field(raw, "miners"));
  const runtime = mapRuntime(field(raw, "runtime"));
  const systemInfo = mapSystemInfo(field(raw, "systemInfo", "system_info"));

  const descriptor: NodeDescriptor = {
    schema: "quip.node_descriptor.v1",
    descriptorVersion: 1,
    nodeName,
    ...(publicHost !== undefined ? { publicHost } : {}),
    ...(publicPort !== undefined ? { publicPort } : {}),
    ...(rpcEndpoints !== undefined ? { rpcEndpoints } : {}),
    ...(logLevel !== undefined ? { logLevel } : {}),
    ...(runtime !== undefined ? { runtime } : {}),
    ...(miners !== undefined ? { miners } : {}),
    ...(systemInfo !== undefined ? { systemInfo } : {}),
  };
  return { updatedAt, descriptor };
}

// Decode the optional schema-v2 `runtime` (node-software) block. String fields
// are `Bytes` (hex via toJSON); protocolVersion is a number, inDocker a bool.
// Unwrapped through the snake/camel-tolerant `field` helper so toHuman and
// toJSON surfacings both decode. Returns undefined for absent/non-object input
// (None / schema-v1) or when every field decoded empty.
function mapRuntime(value: unknown): NodeRuntime | undefined {
  const r = recordOrUndef(value);
  if (!r) return undefined;
  const out: NodeRuntime = {};
  const python = stringFromBytesOption(field(r, "python"));
  const quipVersion = stringFromBytesOption(field(r, "quipVersion", "quip_version"));
  const protocolVersion = numberFromOption(field(r, "protocolVersion", "protocol_version"));
  const inDocker = booleanFromUnknown(field(r, "inDocker", "in_docker"));
  const dockerImage = stringFromBytesOption(field(r, "dockerImage", "docker_image"));
  if (python !== undefined) out.python = python;
  if (quipVersion !== undefined) out.quipVersion = quipVersion;
  if (protocolVersion !== undefined) out.protocolVersion = protocolVersion;
  if (inDocker !== undefined) out.inDocker = inDocker;
  if (dockerImage !== undefined) out.dockerImage = dockerImage;
  return Object.keys(out).length > 0 ? out : undefined;
}

// Decode the optional schema-v2 `system_info` hardware survey. Every string
// field is a `Bytes` (hex via toJSON); numeric fields pass through. Returns
// undefined for absent/non-object input (schema-v1 descriptors). The on-chain
// GPU `utilization_pct` maps to the dashboard's `observedUtilizationPct`.
function mapSystemInfo(value: unknown): NodeSystemInfo | undefined {
  const r = recordOrUndef(value);
  if (!r) return undefined;
  const out: NodeSystemInfo = {};

  const osRaw = recordOrUndef(field(r, "os"));
  if (osRaw) {
    const os: NodeSystemOs = {};
    const system = stringFromBytesOption(field(osRaw, "system"));
    const release = stringFromBytesOption(field(osRaw, "release"));
    const machine = stringFromBytesOption(field(osRaw, "machine"));
    if (system !== undefined) os.system = system;
    if (release !== undefined) os.release = release;
    if (machine !== undefined) os.machine = machine;
    if (Object.keys(os).length > 0) out.os = os;
  }

  const cpuRaw = recordOrUndef(field(r, "cpu"));
  if (cpuRaw) {
    const cpu: NodeSystemCpu = {};
    const logicalCores = numberFromOption(field(cpuRaw, "logicalCores", "logical_cores"));
    const physicalCores = numberFromOption(field(cpuRaw, "physicalCores", "physical_cores"));
    const brand = stringFromBytesOption(field(cpuRaw, "brand"));
    const arch = stringFromBytesOption(field(cpuRaw, "arch"));
    if (logicalCores !== undefined) cpu.logicalCores = logicalCores;
    if (physicalCores !== undefined) cpu.physicalCores = physicalCores;
    if (brand !== undefined) cpu.brand = brand;
    if (arch !== undefined) cpu.arch = arch;
    if (Object.keys(cpu).length > 0) out.cpu = cpu;
  }

  const memoryMb = numberFromOption(field(r, "memoryMb", "memory_mb"));
  if (memoryMb !== undefined) out.memoryMb = memoryMb;

  const gpusJson =
    typeof (field(r, "gpus") as { toJSON?: () => unknown })?.toJSON === "function"
      ? (field(r, "gpus") as { toJSON: () => unknown }).toJSON()
      : field(r, "gpus");
  const gpusRaw = Array.isArray(gpusJson) ? gpusJson : [];
  if (gpusRaw.length > 0) {
    const gpus = gpusRaw
      .map((g): NodeSystemGpu | null => {
        const gr = recordOrUndef(g);
        if (!gr) return null;
        const gpu: NodeSystemGpu = {};
        const index = numberFromOption(field(gr, "index"));
        const vendor = stringFromBytesOption(field(gr, "vendor"));
        const name = stringFromBytesOption(field(gr, "name"));
        const gpuMem = numberFromOption(field(gr, "memoryMb", "memory_mb"));
        const util = numberFromOption(field(gr, "utilizationPct", "utilization_pct"));
        if (index !== undefined) gpu.index = index;
        if (vendor !== undefined) gpu.vendor = vendor;
        if (name !== undefined) gpu.name = name;
        if (gpuMem !== undefined) gpu.memoryMb = gpuMem;
        if (util !== undefined) gpu.observedUtilizationPct = util;
        return Object.keys(gpu).length > 0 ? gpu : null;
      })
      .filter((g): g is NodeSystemGpu => g !== null);
    if (gpus.length > 0) out.gpus = gpus;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

// Coerce a codec/option/plain value to a record via toJSON, returning
// undefined for null/None/non-object input.
function recordOrUndef(value: unknown): Record<string, unknown> | undefined {
  const unwrapped = unwrapOptionLike(value);
  if (unwrapped === null || unwrapped === undefined) return undefined;
  const json =
    typeof (unwrapped as { toJSON?: () => unknown })?.toJSON === "function"
      ? (unwrapped as { toJSON: () => unknown }).toJSON()
      : unwrapped;
  return json && typeof json === "object" && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : undefined;
}

function codecToRecord(value: unknown): Record<string, unknown> {
  const json =
    typeof (value as { toJSON?: () => unknown })?.toJSON === "function"
      ? (value as { toJSON: () => unknown }).toJSON()
      : value;
  return json && typeof json === "object" && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : {};
}

function unwrapOptionLike(value: unknown): unknown | null {
  if (value === null || value === undefined) return null;
  const option = value as { isSome?: boolean; unwrap?: () => unknown; toJSON?: () => unknown };
  if (typeof option.isSome === "boolean") {
    if (!option.isSome || typeof option.unwrap !== "function") return null;
    return option.unwrap();
  }
  const json = typeof option.toJSON === "function" ? option.toJSON() : value;
  return json === null || json === undefined ? null : value;
}

function field(record: Record<string, unknown>, camel: string, snake?: string): unknown {
  if (Object.prototype.hasOwnProperty.call(record, camel)) return record[camel];
  if (snake && Object.prototype.hasOwnProperty.call(record, snake)) return record[snake];
  return undefined;
}

function stringFromBytesOption(value: unknown): string | undefined {
  return stringFromBytes(unwrapOptionLike(value));
}

function stringFromBytes(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    if (!value.startsWith("0x")) return value;
    return utf8FromHex(value);
  }
  if (Array.isArray(value) && value.every((n) => typeof n === "number")) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(value));
    } catch {
      return undefined;
    }
  }
  const codec = value as {
    toUtf8?: () => string;
    toHex?: () => string;
    toU8a?: (isBare?: boolean) => Uint8Array;
    toJSON?: () => unknown;
  };
  if (typeof codec.toUtf8 === "function") return codec.toUtf8();
  if (typeof codec.toHex === "function") return utf8FromHex(codec.toHex());
  if (typeof codec.toU8a === "function") {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(codec.toU8a(true));
    } catch {
      return undefined;
    }
  }
  if (typeof codec.toJSON === "function") return stringFromBytes(codec.toJSON());
  return undefined;
}

function utf8FromHex(hex: string): string | undefined {
  const cleaned = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (cleaned.length === 0 || cleaned.length % 2 !== 0) return undefined;
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    bytes[i / 2] = parseInt(cleaned.slice(i, i + 2), 16);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function stringArrayFromBytes(value: unknown): string[] | undefined {
  const json =
    typeof (value as { toJSON?: () => unknown })?.toJSON === "function"
      ? (value as { toJSON: () => unknown }).toJSON()
      : value;
  if (!Array.isArray(json)) return undefined;
  const out = json.map((entry) => stringFromBytes(entry)).filter((s): s is string => !!s);
  return out.length > 0 ? out : undefined;
}

function numberFromOption(value: unknown): number | undefined {
  return numberFromUnknown(unwrapOptionLike(value));
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const n = Number(value.replaceAll(",", ""));
    return Number.isFinite(n) ? n : undefined;
  }
  const json =
    typeof (value as { toJSON?: () => unknown })?.toJSON === "function"
      ? (value as { toJSON: () => unknown }).toJSON()
      : undefined;
  if (json !== undefined && json !== value) return numberFromUnknown(json);
  const text =
    typeof (value as { toString?: () => string })?.toString === "function"
      ? (value as { toString: () => string }).toString()
      : undefined;
  if (text && text !== "[object Object]") return numberFromUnknown(text);
  return undefined;
}

function stringFromNumeric(value: unknown): string | undefined {
  const n = numberFromUnknown(value);
  if (n !== undefined) return String(n);
  if (typeof value === "bigint") return value.toString();
  const text =
    typeof (value as { toString?: () => string })?.toString === "function"
      ? (value as { toString: () => string }).toString()
      : undefined;
  return text && text !== "[object Object]" ? text : undefined;
}

function booleanFromUnknown(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const json =
    typeof (value as { toJSON?: () => unknown })?.toJSON === "function"
      ? (value as { toJSON: () => unknown }).toJSON()
      : undefined;
  if (typeof json === "boolean") return json;
  return undefined;
}

function enumVariant(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  const json =
    typeof (value as { toJSON?: () => unknown })?.toJSON === "function"
      ? (value as { toJSON: () => unknown }).toJSON()
      : value;
  if (typeof json === "string") return json;
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const keys = Object.keys(json);
    if (keys.length === 1) return keys[0];
  }
  const text =
    typeof (value as { toString?: () => string })?.toString === "function"
      ? (value as { toString: () => string }).toString()
      : undefined;
  return text && text !== "[object Object]" ? text : undefined;
}

function normalizeRegistryMiners(value: unknown): Record<string, NodeMinerEntry> | undefined {
  const json =
    typeof (value as { toJSON?: () => unknown })?.toJSON === "function"
      ? (value as { toJSON: () => unknown }).toJSON()
      : value;
  if (!Array.isArray(json)) return undefined;
  const out: Record<string, NodeMinerEntry> = {};
  json.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const e = entry as Record<string, unknown>;
    const kindVariant = enumVariant(field(e, "kind"));
    const kind = normalizeMinerKind(kindVariant);
    const label = stringFromBytesOption(field(e, "label")) ?? `${kind.toLowerCase()}-${index + 1}`;
    const backend = stringFromBytesOption(field(e, "backend"));
    const deviceId = stringFromBytesOption(field(e, "deviceId", "device_id")) ?? label;
    out[label] = {
      kind,
      minerId: deviceId,
      ...(backend !== undefined && kind === "GPU" ? { backend } : {}),
      ...(backend !== undefined && kind === "QPU" ? { provider: backend } : {}),
    };
  });
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeMinerKind(value: string | undefined): MinerCategory {
  const v = (value ?? "").toLowerCase();
  if (v.includes("cpu")) return "CPU";
  if (v.includes("gpu") || v.includes("cuda") || v.includes("metal")) return "GPU";
  if (v.includes("qpu") || v.includes("dwave") || v.includes("quantum")) return "QPU";
  return "OTHER";
}

// Decode a polkadot.js codec for a v0.2 `DifficultyConfig` struct into the
// dashboard's normalised `DifficultyInfo` shape. Tolerates camelCase
// (toJSON) and snake_case (toHuman) field surfacing.
function decodeDifficulty(codec: unknown): DifficultyInfo {
  const json =
    typeof (codec as { toJSON?: () => unknown })?.toJSON === "function"
      ? ((codec as { toJSON: () => Record<string, unknown> }).toJSON() as Record<string, unknown>)
      : ((codec as Record<string, unknown>) ?? {});
  return {
    maxEnergyMilli: Number(json.maxEnergyMilli ?? json.max_energy_milli ?? 0),
    minDiversityMilli: Number(json.minDiversityMilli ?? json.min_diversity_milli ?? 0),
    minSolutions: Number(json.minSolutions ?? json.min_solutions ?? 0),
  };
}
