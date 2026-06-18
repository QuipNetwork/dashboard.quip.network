// SPDX-License-Identifier: AGPL-3.0-or-later
//
// blocks: per finalized block → authorship → filter to winners → enrich → scan
// difficulty → insert. Live and the startup backfill run as independent
// pipelines sharing this one writer.

import type { BlockRecord } from "@quip/shared/telemetry";
import {
  EMPTY,
  type Observable,
  catchError,
  concatMap,
  defer,
  filter,
  from,
  ignoreElements,
  map,
  merge,
  scan,
  tap,
} from "rxjs";

import type { BlockEvents, DifficultyInfo, TopologyInfo } from "../clients/substrate-client";
import { BoundedKeySet } from "../core/bounded-key-set";
import { type WorkerContext, nowIso } from "../core/worker";
import { Backfill } from "./backfill";
import type { BackfillSource, BlockSource, ConnectionStream } from "./ports";
import { BABE_SLOT_DURATION_SEC } from "./shared";
import { fromChainSubscription } from "./streams";

const ZERO_DIFFICULTY: DifficultyInfo = {
  maxEnergyMilli: 0,
  minDiversityMilli: 0,
  minSolutions: 0,
};

// Per-connection authorship-dedup window. Far exceeds any realistic live/
// backfill startup overlap, so dedup is preserved while memory stays bounded
// (~2x this many keys) on a connection that never reconnects.
const AUTHORSHIP_DEDUP_WINDOW = 50_000;

type WinningBlock = BlockEvents & { winner: NonNullable<BlockEvents["winner"]> };
type ProofInfo = BlockEvents["proofs"][number];

// Thrown to drop a block; caught per-block so the connection survives.
class SkippedBlock extends Error {
  constructor(
    readonly blockNumber: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}

function logSkip(err: unknown): Observable<never> {
  if (err instanceof SkippedBlock) {
    console.warn(`[indexer/substrate] block #${err.blockNumber}: ${err.reason}; skipping insert`);
  } else {
    console.warn("[indexer/substrate] block enrich failed:", err);
  }
  return EMPTY;
}

interface EnrichedBlock {
  e: WinningBlock;
  winningProof: ProofInfo;
  nonce: string;
  miningTime: number;
  ownDifficulty: DifficultyInfo | null;
}

async function enrichBlock(client: BlockSource, e: WinningBlock): Promise<EnrichedBlock> {
  const winningProof = e.proofs.find(
    (p) => p.miner === e.winner.miner && p.energyMilli === e.winner.energyMilli,
  );
  if (!winningProof) {
    throw new SkippedBlock(e.blockNumber, "BlockWinner without matching ProofAccepted");
  }
  // A "0" nonce sentinel would collide with the legitimate u64 value 0, so a
  // null nonce is skipped rather than defaulted.
  if (e.nonce === null) {
    throw new SkippedBlock(e.blockNumber, "BlockWinner without recoverable submit_proof nonce");
  }

  // LastProofBlock is read at the PARENT hash: on_finalize updates it in-block,
  // so the parent's value is the prior tip. Independent of the winSol read.
  const [lastProofBlock, winSol] = await Promise.all([
    client.getLastProofBlockAt(e.parentHash),
    client.getWinningSolution(String(e.blockNumber)).catch(() => null),
  ]);
  const miningTimeBlocks = lastProofBlock > 0 ? Math.max(1, e.blockNumber - lastProofBlock) : 0;
  const miningTime = miningTimeBlocks * BABE_SLOT_DURATION_SEC;

  return { e, winningProof, nonce: e.nonce, miningTime, ownDifficulty: winSol?.difficulty ?? null };
}

// `block` is null only in the scan seed, which is never emitted.
interface DifficultyScan {
  lastDifficulty: DifficultyInfo | null;
  difficulty: DifficultyInfo;
  block: EnrichedBlock | null;
}

// Pre-v0.2 blocks carry no own difficulty; fall back to the prior block's.
function threadDifficulty(acc: DifficultyScan, block: EnrichedBlock): DifficultyScan {
  const lastDifficulty = block.ownDifficulty ?? acc.lastDifficulty;
  return { lastDifficulty, difficulty: lastDifficulty ?? ZERO_DIFFICULTY, block };
}

function buildBlockRecord(
  topology: TopologyInfo,
  enriched: EnrichedBlock,
  difficulty: DifficultyInfo,
): BlockRecord {
  const { e, winningProof, nonce, miningTime } = enriched;
  return {
    blockHash: e.blockHash,
    substrateBlockNumber: String(e.blockNumber),
    substrateBlockHash: e.blockHash,
    substrateParentHash: e.parentHash,
    timestamp: e.timestamp,
    minerId: e.winner.miner,
    energy: e.winner.energyMilli / 1000,
    diversity: winningProof.diversityMilli / 1000,
    numValidSolutions: winningProof.validSolutionCount,
    miningTime,
    reward: e.winner.reward,
    nonce,
    numNodes: topology.nodeCount,
    numEdges: topology.edgeCount,
    difficultyEnergy: difficulty.maxEnergyMilli / 1000,
    minDiversity: difficulty.minDiversityMilli / 1000,
    minSolutions: difficulty.minSolutions,
    finalized: true, // backfill + subscribe are both finalized-only
  };
}

export class BlockPipeline implements ConnectionStream {
  private readonly backfill: Backfill;
  // recordValidatorAuthorship is increment-by-1, so dedup per connection. The
  // only re-delivery this guards is the live/backfill overlap near startup
  // (finalized blocks never arrive twice), so a bounded window is ample — and
  // keeps the set from growing for the life of a long-lived connection.
  private readonly seen = new BoundedKeySet(AUTHORSHIP_DEDUP_WINDOW);

  constructor(
    private readonly ctx: WorkerContext,
    private readonly client: BlockSource & BackfillSource,
  ) {
    this.backfill = new Backfill(ctx, client);
  }

  stream(): Observable<never> {
    return defer(() => from(this.prime())).pipe(
      concatMap(({ topology, seedDifficulty }) => {
        const live$ = fromChainSubscription<BlockEvents>((cb) =>
          this.client.subscribeBlockEvents(cb),
        );
        // Live and backfill run as independent (concurrent) pipelines so a large
        // backfill never head-of-line-blocks live writes; they share `seen` and
        // the idempotent insert, so a block seen by both is harmless.
        const process = (source$: Observable<BlockEvents>): Observable<never> =>
          source$.pipe(
            tap(() => {
              this.ctx.state.observability.lastSubstrateEventAt = nowIso(this.ctx);
            }),
            concatMap((e) => from(this.recordAuthorship(e)).pipe(map(() => e))),
            filter((e): e is WinningBlock => e.winner !== null),
            concatMap((e) => from(enrichBlock(this.client, e)).pipe(catchError(logSkip))),
            scan(threadDifficulty, this.seedScan(seedDifficulty)),
            concatMap(({ block, difficulty }) => {
              const enriched = block!; // scan only emits after a real block
              return from(this.insertBlock(buildBlockRecord(topology, enriched, difficulty))).pipe(
                catchError((err) => {
                  console.warn(
                    `[indexer/substrate] block #${enriched.e.blockNumber} writer failed:`,
                    err,
                  );
                  return EMPTY;
                }),
              );
            }),
            ignoreElements(),
          );
        return merge(process(live$), process(this.backfill.stream()));
      }),
      ignoreElements(),
    );
  }

  private seedScan(seedDifficulty: DifficultyInfo | null): DifficultyScan {
    return { lastDifficulty: seedDifficulty, difficulty: ZERO_DIFFICULTY, block: null };
  }

  // Primes the topology + difficulty fallbacks used until per-block reads land.
  private async prime(): Promise<{
    topology: TopologyInfo;
    seedDifficulty: DifficultyInfo | null;
  }> {
    const topology = await this.client.getTopology().catch(() => null);
    const seedDifficulty = await this.client.getDifficulty().catch(() => null);
    return { topology: topology ?? { nodeCount: 0, edgeCount: 0 }, seedDifficulty };
  }

  // Recorded for every authored block, winnerless heads included. The key is
  // claimed in `seen` BEFORE the await so the dedup is race-free across the two
  // concurrent pipelines; released on failure so a later delivery can retry.
  private async recordAuthorship(e: BlockEvents): Promise<void> {
    if (e.author === null) return;
    const key = `${e.author}|${e.blockNumber}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    try {
      await this.ctx.db.recordValidatorAuthorship(
        e.author,
        String(e.blockNumber),
        e.timestamp,
        e.winner !== null,
      );
    } catch (err) {
      this.seen.delete(key);
      console.warn(
        `[indexer/substrate] block #${e.blockNumber}: validator authorship write failed:`,
        err,
      );
    }
  }

  private async insertBlock(record: BlockRecord): Promise<void> {
    await this.ctx.db.insertBlock(record);
    this.ctx.state.observability.lastBlockInsertAt = nowIso(this.ctx);
  }
}
