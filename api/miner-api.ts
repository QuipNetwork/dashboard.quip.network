// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Parsers and types shared by both the indexer's poll loop and the server's
// modal-proxy route. Lives in `api/` so neither the indexer (worker side)
// nor the server (request side) has to import across the other's
// directory boundary — same pattern as `api/db/adapter`.

import type { MiningAttempt, MiningAttemptsResponse, MiningSubmissionRecord } from "../src/types/telemetry";

interface RawSubmission {
  type?: string;
  ts_ns?: number | string;
  solution_id?: number | string;
  miner_id?: string;
  dispatch_id?: number | string;
  energy_milli?: number | string;
  diversity_milli?: number | string;
  threshold_milli?: number | string;
  last_proof_block_hash?: string;
  extrinsic_hash?: string | null;
  chain_block_hash?: string | null;
  chain_block_number?: number | string | null;
  outcome?: string;
}

interface RawAttempt {
  type?: string;
  iter?: number | string;
  best_energy_milli?: number | string;
  result_kind?: string;
  [k: string]: unknown;
}

interface RawEnvelope {
  submission?: RawSubmission;
  attempts?: RawAttempt[];
}

/**
 * Normalise the miner's `/api/v1/mining/attempts` envelope into the
 * dashboard's camelCase shape. Computes `attemptCount` and
 * `bestEnergyMilli` from the attempts array so callers don't have to —
 * the indexer needs both to persist the summary row, and the modal can
 * use them as fallbacks if the miner adds them server-side later.
 *
 * Throws on missing required fields (solutionId, minerId, outcome,
 * energyMilli). A `null` envelope.submission means the miner didn't
 * find the requested solution_id — callers should pass through the
 * 404, not call this.
 */
export function parseMiningAttemptsApiResponse(raw: unknown): MiningAttemptsResponse {
  if (!raw || typeof raw !== "object") {
    throw new Error("mining-attempts: response is not an object");
  }
  const env = raw as RawEnvelope;
  if (!env.submission || typeof env.submission !== "object") {
    throw new Error("mining-attempts: missing `submission` field");
  }
  const s = env.submission;
  const requireStr = (v: unknown, name: string): string => {
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`mining-attempts: missing string field \`${name}\``);
    }
    return v;
  };
  const requireNum = (v: unknown, name: string): number => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) {
      throw new Error(`mining-attempts: missing numeric field \`${name}\` (got ${String(v)})`);
    }
    return n;
  };
  const attempts = parseAttempts(env.attempts);
  const submission: MiningSubmissionRecord = {
    solutionId: requireNum(s.solution_id, "solution_id"),
    minerId: requireStr(s.miner_id, "miner_id"),
    dispatchId: requireNum(s.dispatch_id, "dispatch_id"),
    tsNs: String(s.ts_ns ?? "0"),
    energyMilli: requireNum(s.energy_milli, "energy_milli"),
    diversityMilli: requireNum(s.diversity_milli, "diversity_milli"),
    thresholdMilli: requireNum(s.threshold_milli, "threshold_milli"),
    lastProofBlockHash: requireStr(s.last_proof_block_hash, "last_proof_block_hash"),
    extrinsicHash: s.extrinsic_hash ?? null,
    chainBlockHash: s.chain_block_hash ?? null,
    chainBlockNumber:
      s.chain_block_number === null || s.chain_block_number === undefined
        ? null
        : String(s.chain_block_number),
    outcome: requireStr(s.outcome, "outcome"),
    attemptCount: attempts.length,
    bestEnergyMilli: bestEnergy(attempts, submissionEnergy(s)),
    // observedAt is the caller's responsibility — both the indexer (write
    // path) and the server proxy (read-through path) stamp this with the
    // wall-clock at fetch time, not at parse time. The submission record
    // is otherwise pure-projection of the miner's response.
    observedAt: "",
  };
  return { submission, attempts };
}

function submissionEnergy(s: RawSubmission): number {
  const n = typeof s.energy_milli === "number" ? s.energy_milli : Number(s.energy_milli);
  return Number.isFinite(n) ? n : 0;
}

function parseAttempts(raw: RawAttempt[] | undefined): MiningAttempt[] {
  if (!Array.isArray(raw)) return [];
  const out: MiningAttempt[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const iterN = typeof a.iter === "number" ? a.iter : Number(a.iter);
    const bestN =
      typeof a.best_energy_milli === "number" ? a.best_energy_milli : Number(a.best_energy_milli);
    // Skip malformed rows rather than throw — one bad iteration shouldn't
    // sink the whole modal payload.
    if (!Number.isFinite(iterN) || !Number.isFinite(bestN)) continue;
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a)) {
      if (k === "type" || k === "iter" || k === "best_energy_milli" || k === "result_kind") {
        continue;
      }
      extra[k] = v;
    }
    out.push({
      iter: iterN,
      bestEnergyMilli: bestN,
      resultKind: typeof a.result_kind === "string" ? a.result_kind : "",
      extra,
    });
  }
  return out;
}

/**
 * Lowest (most-difficult-cleared) `bestEnergyMilli` across the iteration
 * trail. Falls back to the submission's own `energy_milli` when the
 * miner returned an empty attempts array — the submission itself is the
 * single observable data point in that case.
 */
function bestEnergy(attempts: MiningAttempt[], fallback: number): number {
  if (attempts.length === 0) return fallback;
  let best = attempts[0]!.bestEnergyMilli;
  for (let i = 1; i < attempts.length; i++) {
    const v = attempts[i]!.bestEnergyMilli;
    if (v < best) best = v;
  }
  return best;
}

/**
 * The `?miner_id=X&dispatch_id=Y` form of `/api/v1/mining/attempts`
 * returns only `attempts[]` (no submission join). Use this for live
 * polling of the in-flight dispatch — the iterations the miner is
 * currently grinding against the outstanding problem.
 *
 * Returns an empty array on any structural failure; the caller decides
 * whether to surface "empty" as "no attempts yet" or "fetch failed".
 */
export function parseDispatchAttemptsApiResponse(raw: unknown): MiningAttempt[] {
  if (!raw || typeof raw !== "object") return [];
  const env = raw as { attempts?: RawAttempt[] };
  return parseAttempts(env.attempts);
}

/**
 * Distinct error type for `solution_id` lookups the miner returns 404 on.
 * Lets the indexer's poll loop treat "not yet observable" differently
 * from a transport failure: we just retry next tick, no checkpoint
 * advancement past the missing id.
 */
export class MiningSubmissionNotFoundError extends Error {
  constructor(public readonly solutionId: number) {
    super(`mining submission ${solutionId} not found`);
    this.name = "MiningSubmissionNotFoundError";
  }
}
