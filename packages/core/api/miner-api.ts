// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Parsers and types shared by both the indexer's poll loop and the server's
// modal-proxy route. Lives in `api/` so neither the indexer (worker side)
// nor the server (request side) has to import across the other's
// directory boundary — same pattern as `api/db/adapter`.

import type {
  MiningAttempt,
  MiningAttemptsResponse,
  MiningSubmissionRecord,
} from "@quip/shared/telemetry";

interface RawSubmission {
  type?: string;
  ts_ns?: number | string;
  // Global chain solution number (quip-protocol MR !105): the directory
  // key and stable identity. Replaces the pre-!105 `solution_id` /
  // `dispatch_id` controller-local counters, which are gone from the
  // miner JSON entirely.
  solution_number?: number | string;
  miner_id?: string;
  miner_type?: string;
  energy_milli?: number | string;
  diversity_milli?: number | string;
  threshold_milli?: number | string;
  last_proof_block_hash?: string;
  extrinsic_hash?: string | null;
  chain_block_hash?: string | null;
  chain_block_number?: number | string | null;
  // Submission-level count (quip-protocol MR !105): unique samples
  // meeting the energy threshold at submit time — the target-aware
  // count the chain accepts. Authoritative source for the "Solutions"
  // column; the per-iteration trail is only a pre-!105 fallback.
  num_valid?: number | string | null;
  // On-chain `proofs_submitted` sequence (MR !105), attached to
  // non-winning submissions (rejected / chain_error). Winners carry
  // `chain_block_number` instead — the two are mutually exclusive by
  // outcome, and "Sol #" is derived from whichever is present.
  pow_sequence?: number | string | null;
  outcome?: string;
}

interface RawAttempt {
  type?: string;
  iter?: number | string;
  best_energy_milli?: number | string;
  result_kind?: string;
  miner_type?: string;
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
 * Throws on missing required fields (solutionNumber, minerId, outcome,
 * energyMilli). A `null` envelope.submission means the miner didn't
 * find the requested solution_number — callers should pass through the
 * 404, not call this.
 */
export function parseMiningAttemptsApiResponse(raw: unknown): MiningAttemptsResponse {
  if (!raw || typeof raw !== "object") {
    throw new MiningSubmissionUnparsableError("response is not an object");
  }
  const env = raw as RawEnvelope;
  if (!env.submission || typeof env.submission !== "object") {
    throw new MiningSubmissionUnparsableError("missing `submission` field");
  }
  const s = env.submission;
  const requireStr = (v: unknown, name: string): string => {
    if (typeof v !== "string" || v.length === 0) {
      throw new MiningSubmissionUnparsableError(`missing string field \`${name}\``);
    }
    return v;
  };
  const requireNum = (v: unknown, name: string): number => {
    const n = safeNumber(v);
    if (n === null) {
      throw new MiningSubmissionUnparsableError(
        `missing or out-of-range numeric field \`${name}\` (got ${String(v)})`,
      );
    }
    return n;
  };
  const attempts = parseAttempts(env.attempts);
  const submission: MiningSubmissionRecord = {
    solutionNumber: requireNum(s.solution_number, "solution_number"),
    minerId: requireStr(s.miner_id, "miner_id"),
    // miner_type is optional — older miners omit it; tolerate both.
    minerType: typeof s.miner_type === "string" ? s.miner_type : "",
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
    powSequence: optionalNum(s.pow_sequence),
    outcome: requireStr(s.outcome, "outcome"),
    attemptCount: attempts.length,
    bestEnergyMilli: bestEnergy(attempts, submissionEnergy(s)),
    numValid: extractNumValid(s, attempts, env.attempts),
    qpuAccessTimeUs: sumQpuAccessTimeUs(env.attempts),
    // observedAt is the caller's responsibility — both the indexer (write
    // path) and the server proxy (read-through path) stamp this with the
    // wall-clock at fetch time, not at parse time. The submission record
    // is otherwise pure-projection of the miner's response.
    observedAt: "",
  };
  return { submission, attempts };
}

/**
 * Count behind the Recent Performance "Solutions" column.
 *
 * Authoritative source (quip-protocol MR !105): the submission-level
 * `num_valid` field, recorded on every submission — the target-aware
 * count of unique samples meeting the energy threshold (the count the
 * chain accepts, ≥ min_solutions below max_energy). When present this
 * wins outright, including a legitimate 0 (e.g. a chain_error before
 * any candidate cleared the live threshold).
 *
 * Fallback for pre-!105 envelopes that carry no submission-level count:
 * derive it from the iteration trail. Post-!103 the per-iteration
 * figure lives in `solution_meta.n_unique_total` (the target-blind
 * productivity count); pre-!103 images carried it as the top-level
 * (per-iteration) `num_valid`. Falls back to 0 when no iteration
 * carried either field.
 *
 * NB the fallback yields the target-BLIND productivity count, whereas
 * the !105 primary yields the target-AWARE accepted count — the column
 * meaning converges on the latter as the fleet upgrades.
 */
function extractNumValid(
  s: RawSubmission,
  parsed: MiningAttempt[],
  raw: RawAttempt[] | undefined,
): number {
  const submissionLevel = optionalNum(s.num_valid);
  if (submissionLevel !== null) return submissionLevel;
  if (!Array.isArray(raw)) return 0;
  // Walk in order — pick the LAST submitted row, since miners that
  // resubmit (rare) leave the most recent submission as the canonical
  // one.
  for (let i = raw.length - 1; i >= 0; i--) {
    const r = raw[i];
    if (!r) continue;
    const kind = typeof r.result_kind === "string" ? r.result_kind.toLowerCase() : "";
    if (!kind.includes("submit")) continue;
    const n = productivityFromRaw(r);
    if (n !== null) return n;
  }
  // Fall back to the last attempt's count if the chain-submitted iteration
  // didn't carry one (mempool path, chain_error). Still 0 if the miner
  // never published either field.
  for (let i = parsed.length - 1; i >= 0; i--) {
    const a = parsed[i];
    if (!a) continue;
    const n = nestedNumber(a.extra["solution_meta"], "n_unique_total");
    if (n !== null) return n;
    const legacy = numericExtra(a.extra["num_valid"]);
    if (legacy !== null) return legacy;
  }
  return 0;
}

/**
 * Target-blind productivity from one raw attempt: prefer the !103+
 * `solution_meta.n_unique_total`, else the legacy top-level `num_valid`.
 */
function productivityFromRaw(r: RawAttempt): number | null {
  const fromMeta = nestedNumber(r["solution_meta"], "n_unique_total");
  if (fromMeta !== null) return fromMeta;
  return numericExtra(r["num_valid"]);
}

/**
 * Read a numeric scalar out of a nested object field (e.g. the miner's
 * `solution_meta` dict). Returns null when the container is absent or
 * the key is missing / non-numeric — never throws.
 */
function nestedNumber(container: unknown, key: string): number | null {
  if (!container || typeof container !== "object") return null;
  return numericExtra((container as Record<string, unknown>)[key]);
}

/**
 * Sum the optional `qpu_access_time_us` field across every iteration
 * row. Field is added by future miner versions (D-Wave's
 * `sampler.info["qpu_access_time"]` per sample-set, in microseconds);
 * older miners and CPU/GPU miners that have no quantum sampler omit
 * it entirely. Missing / non-numeric entries contribute 0 rather than
 * polluting the sum or rejecting the parse — the QPU compute chart
 * degrades to 0 until the field lands, never crashes.
 */
function sumQpuAccessTimeUs(raw: RawAttempt[] | undefined): number {
  if (!Array.isArray(raw)) return 0;
  let total = 0;
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const v = numericExtra(a["qpu_access_time_us"]);
    if (v !== null && v > 0) total += v;
  }
  return total;
}

/**
 * Coerce a wire scalar to a number the dashboard can persist, or null.
 *
 * Rule N1 of the quip-miner v0.3 REST contract: every integer the miner
 * serializes as a JSON number must fall inside the IEEE-754 safe integer
 * range. Beyond it, `Number()` has already rounded — the coordinator's
 * `i64::MAX` no-solution sentinel arrives as 9223372036854775808 and
 * serializes back out as "9223372036854776000", which PostgreSQL rejects for
 * the BIGINT columns of `mining_submissions`. Rejecting here keeps a rounded
 * value from ever reaching the insert.
 *
 * The bound is on magnitude rather than `Number.isSafeInteger` so a genuinely
 * fractional field (none today) still parses.
 */
function safeNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) > Number.MAX_SAFE_INTEGER) return null;
  return n;
}

function numericExtra(v: unknown): number | null {
  if (typeof v === "number" || typeof v === "string") return safeNumber(v);
  return null;
}

/**
 * Parse an optional numeric submission field (number or numeric string)
 * into `number | null`. Null/undefined/empty/non-numeric all map to
 * null — the caller treats null as "miner didn't report it". Distinct
 * from `numericExtra` only in intent (nullable scalar fields vs the
 * `extra` map), but shares the same coercion so behaviour stays uniform.
 */
function optionalNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return numericExtra(v);
}

function submissionEnergy(s: RawSubmission): number {
  return safeNumber(s.energy_milli) ?? 0;
}

function parseAttempts(raw: RawAttempt[] | undefined): MiningAttempt[] {
  if (!Array.isArray(raw)) return [];
  const out: MiningAttempt[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const iterN = safeNumber(a.iter);
    const bestN = safeNumber(a.best_energy_milli);
    // Skip malformed rows rather than throw — one bad iteration shouldn't
    // sink the whole modal payload. Out-of-range counts as malformed: the
    // submission's `bestEnergyMilli` is the minimum across these rows and
    // lands in a BIGINT column, so a rounded value would poison it.
    if (iterN === null || bestN === null) continue;
    // miner_type is hoisted to a typed field; exclude it from `extra` so
    // it isn't displayed twice in the modal's "extras" detail rows.
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a)) {
      if (
        k === "type" ||
        k === "iter" ||
        k === "best_energy_milli" ||
        k === "result_kind" ||
        k === "miner_type"
      ) {
        continue;
      }
      extra[k] = v;
    }
    out.push({
      iter: iterN,
      bestEnergyMilli: bestN,
      resultKind: typeof a.result_kind === "string" ? a.result_kind : "",
      minerType: typeof a.miner_type === "string" ? a.miner_type : "",
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
 * The `?miner_id=X&solution_number=Y` form of `/api/v1/mining/attempts`
 * returns only `attempts[]` (no submission join). Use this for live
 * polling of the in-flight solution — the iterations the miner is
 * currently grinding against the current global problem.
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
 * Distinct error type for `solution_number` lookups the miner returns
 * 404 on. Lets the indexer's poll loop treat a sparse gap (a global
 * solution_number this miner has no directory for — it came online
 * later, or that win belonged to another miner) differently from a
 * transport failure: skip the number and advance, never retry it.
 */
export class MiningSubmissionNotFoundError extends Error {
  constructor(public readonly solutionNumber: number) {
    super(`mining submission ${solutionNumber} not found`);
    this.name = "MiningSubmissionNotFoundError";
  }
}

/**
 * The miner answered, but the body cannot become a row: a required field is
 * absent, or a number arrived outside the range PostgreSQL accepts for the
 * column it lands in (rule N1).
 *
 * Permanent for a given body, which is what separates it from a transport
 * failure. Retrying the same `solution_number` produces the same result, so
 * the indexer's poll loop skips it and advances the checkpoint — the same
 * treatment a 404 gets. Without that distinction one unparsable solution
 * stalls the walk forever and no later solution is ever indexed.
 */
export class MiningSubmissionUnparsableError extends Error {
  constructor(reason: string) {
    super(`mining-attempts: ${reason}`);
    this.name = "MiningSubmissionUnparsableError";
  }
}
