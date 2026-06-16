// SPDX-License-Identifier: AGPL-3.0-or-later

import { nowIso, type ConnectedDeps } from "./substrate-worker-shared";

export interface PollIdempotencyCache {
  // Hash of (epochIndex, currentSlot) — bumped on every observed change.
  babeEpochHash: string | null;
  // Hash of (energy, diversity, solutions, quality) — bumped on every
  // observed change. Doubles as the dedupe key for insertDifficultySnapshot.
  difficultyHash: string | null;
  // Hash of the sorted (accountId,deposit,proofs,rewards) tuples — bumped
  // when any miner's on-chain state changes. Single hash for the whole set
  // since polling cadence is coarse (default 300s); a granular diff would
  // add complexity for no win.
  chainMinersHash: string | null;
  // Hash of (epochIndex + sorted authority account IDs).
  babeAuthoritiesHash: string | null;
}

/**
 * Poll BABE epoch state. Skips the DB write when (epochIndex, currentSlot)
 * matches the last observed values — saves a transaction per uneventful
 * tick. Capability-checked (Fake / chains without BABE return null).
 */
export async function pollBabeEpoch(
  deps: ConnectedDeps,
  cache: PollIdempotencyCache,
): Promise<void> {
  const info = await deps.client.getBabeEpoch();
  if (!info) return;
  const hash = `${info.epochIndex}:${info.currentSlot}`;
  if (hash === cache.babeEpochHash) return;
  cache.babeEpochHash = hash;

  // currentSlotInEpoch via modulo. We can't subtract epochStartSlot because
  // BABE slots are absolute (include genesisSlot) — `epochIndex *
  // slotsPerEpoch` doesn't match the actual epoch boundary. Modulo gives
  // the correct in-epoch offset regardless of when the chain started, and
  // is bounded by slotsPerEpoch so it always fits in a small int.
  let currentSlotInEpoch = 0;
  try {
    currentSlotInEpoch = Number(BigInt(info.currentSlot) % BigInt(info.slotsPerEpoch));
  } catch {
    // Malformed slot values — leave at 0 rather than throw; the BABE
    // progress bar will show empty until the next poll lands clean data.
  }

  await deps.db.upsertBabeEpoch({
    epochIndex: info.epochIndex,
    currentSlot: info.currentSlot,
    epochStartSlot: info.epochStartSlot,
    slotsPerEpoch: info.slotsPerEpoch,
    currentSlotInEpoch,
    authorityCount: info.authorityCount,
  });
}

/**
 * Poll `quantum_pow.Difficulty` and append a row to `difficulty_history`
 * when the snapshot has changed. Converts chain's milli-encoded floats
 * (max_energy_milli, min_diversity_milli) into the "human" units the
 * dashboard's BlockRecord already uses.
 *
 * `observed_at_block` is the substrate finalized height we know at poll
 * time. When the chain hasn't emitted a finalized head yet
 * (finalizedBlockHeight=null), we skip — there's no meaningful block to
 * anchor the snapshot to.
 */
export async function pollDifficulty(
  deps: ConnectedDeps,
  cache: PollIdempotencyCache,
): Promise<void> {
  const info = await deps.client.getDifficulty();
  if (!info) return;
  const observedAtBlock = deps.state.observability.finalizedBlockHeight;
  if (observedAtBlock === null) return;
  // Convert milli → float (the dashboard's BlockRecord uses floats; chain
  // stores u32/i64 milli-encodings to avoid floating-point in consensus).
  const difficultyEnergy = info.maxEnergyMilli / 1000;
  const minDiversity = info.minDiversityMilli / 1000;
  const hash = `${difficultyEnergy}:${minDiversity}:${info.minSolutions}`;
  if (hash === cache.difficultyHash) return;
  cache.difficultyHash = hash;

  await deps.db.insertDifficultySnapshot({
    observedAtBlock,
    difficultyEnergy,
    minDiversity,
    minSolutions: info.minSolutions,
    observedAt: nowIso(deps),
  });
}

/**
 * Poll the on-chain miner registry (`quantum_pow.Miners`) and the BABE
 * authority set (`session.validators`). Both share the same cadence
 * because they're chain-static enough that fine-grained timers add no
 * value — once per `substrateChainPollSec` is plenty.
 *
 * Authorities require a current BABE epoch in the cache to key on; if
 * the BABE poll hasn't completed yet (first connect window), the
 * authorities write is deferred to the next tick. Miners write
 * unconditionally — they're keyed by account ID, not by era.
 */
export async function pollChainState(
  deps: ConnectedDeps,
  cache: PollIdempotencyCache,
): Promise<void> {
  const [miners, authorities, epoch] = await Promise.all([
    deps.client.getChainMiners(),
    deps.client.getBabeAuthorities(),
    deps.client.getBabeEpoch(),
  ]);

  // --- Miners ---
  // Sort by accountId so the hash is order-independent. Storage entries
  // come from a map and have no inherent ordering.
  const sortedMiners = [...miners].sort((a, b) =>
    a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0,
  );
  const minersHash = sortedMiners
    .map(
      (m) => `${m.accountId}:${m.deposit}:${m.proofsSubmitted}:${m.proofsWon}:${m.rewardsEarned}`,
    )
    .join("|");
  if (minersHash !== cache.chainMinersHash) {
    cache.chainMinersHash = minersHash;
    await deps.db.upsertChainMiners(
      sortedMiners.map((m) => ({
        accountId: m.accountId,
        deposit: m.deposit,
        proofsSubmitted: m.proofsSubmitted,
        proofsWon: m.proofsWon,
        rewardsEarned: m.rewardsEarned,
      })),
    );
  }

  // --- BABE authorities ---
  if (epoch) {
    const sortedAuthorities = [...authorities].sort((a, b) =>
      a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0,
    );
    const authoritiesHash = `${epoch.epochIndex}|${sortedAuthorities.map((a) => a.accountId).join(",")}`;
    if (authoritiesHash !== cache.babeAuthoritiesHash) {
      cache.babeAuthoritiesHash = authoritiesHash;
      await deps.db.upsertBabeAuthorities(epoch.epochIndex, sortedAuthorities);
    }
  }
}
