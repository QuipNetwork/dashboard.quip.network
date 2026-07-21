// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Historical state at the requested block has been discarded by a pruning
 * node (spec §8 tier-2 reads). Surfaced distinctly so the dispatcher can
 * ratchet per-plugin pruned floors (block-data reads) or degrade in place
 * (enrichment reads) instead of treating it as a transient failure.
 */
export class StatePrunedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatePrunedError";
  }
}

// The failure mode substrate pruning nodes surface (see the note at
// getDefaultTopologyAt): "State already discarded for <hash>".
export function isStateDiscardedError(err: unknown): boolean {
  if (err instanceof StatePrunedError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /state already discarded|pruned/i.test(msg);
}

/** Rethrow pruned-state failures typed; pass everything else through. */
export function mapPruned(err: unknown): never {
  if (!(err instanceof StatePrunedError) && isStateDiscardedError(err)) {
    throw new StatePrunedError(err instanceof Error ? err.message : String(err));
  }
  throw err;
}
