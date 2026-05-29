// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";

import { parseMiningAttemptsApiResponse } from "./miner-api";

// Build a minimal valid envelope and let each test override only the
// pieces it cares about. The parser requires solution_id, miner_id,
// outcome, energy_milli, diversity_milli, threshold_milli, and
// last_proof_block_hash on the submission; everything else is
// optional or has a default.
function envelope(opts: { attempts: Array<Record<string, unknown>> }): unknown {
  return {
    submission: {
      type: "submission",
      ts_ns: 1779800814740919882n.toString(),
      solution_id: 1,
      miner_id: "quip-miner-pow-QPU-DWAVE-1",
      miner_type: "QPU",
      dispatch_id: 1,
      energy_milli: -14869000,
      diversity_milli: 250,
      threshold_milli: -14910591,
      last_proof_block_hash: "0xabc",
      extrinsic_hash: null,
      chain_block_hash: null,
      chain_block_number: null,
      outcome: "submitted_inblock",
    },
    attempts: opts.attempts,
  };
}

describe("parseMiningAttemptsApiResponse — qpu_access_time_us aggregation", () => {
  test("sums qpu_access_time_us across all iterations", () => {
    // Two iterations each report their own qpu_access_time_us slice.
    // The submission row carries the sum so the dashboard only joins
    // by chainBlockNumber, not by iteration.
    const env = envelope({
      attempts: [
        {
          type: "attempt",
          iter: 1,
          best_energy_milli: -14777000,
          result_kind: "stored",
          qpu_access_time_us: 84_000,
        },
        {
          type: "attempt",
          iter: 2,
          best_energy_milli: -14845000,
          result_kind: "rejected",
          qpu_access_time_us: 84_000,
        },
      ],
    });
    const parsed = parseMiningAttemptsApiResponse(env);
    expect(parsed.submission.qpuAccessTimeUs).toBe(168_000);
  });

  test("defaults to 0 when no iterations carry the field", () => {
    // CPU/GPU miners, older QPU images: field absent. The parser
    // emits 0 rather than throwing — keeps the indexer flowing
    // while the miner-side change is rolling out.
    const env = envelope({
      attempts: [
        {
          type: "attempt",
          iter: 1,
          best_energy_milli: -14777000,
          result_kind: "stored",
          // no qpu_access_time_us
        },
      ],
    });
    expect(parseMiningAttemptsApiResponse(env).submission.qpuAccessTimeUs).toBe(0);
  });

  test("tolerates partial coverage — only some iterations report the field", () => {
    // Rolling miner upgrade or a per-iter sampler info miss. Sum
    // what we have; the rest contribute 0.
    const env = envelope({
      attempts: [
        { type: "attempt", iter: 1, best_energy_milli: -1, qpu_access_time_us: 50_000 },
        { type: "attempt", iter: 2, best_energy_milli: -1 }, // missing
        { type: "attempt", iter: 3, best_energy_milli: -1, qpu_access_time_us: 70_000 },
      ],
    });
    expect(parseMiningAttemptsApiResponse(env).submission.qpuAccessTimeUs).toBe(120_000);
  });

  test("skips non-numeric / negative qpu_access_time_us values", () => {
    // Defensive: a miner that emits the field as a JSON string would
    // still parse via numericExtra, but anything non-finite or
    // negative is treated as "no data".
    const env = envelope({
      attempts: [
        { type: "attempt", iter: 1, best_energy_milli: -1, qpu_access_time_us: "abc" },
        { type: "attempt", iter: 2, best_energy_milli: -1, qpu_access_time_us: -100 },
        { type: "attempt", iter: 3, best_energy_milli: -1, qpu_access_time_us: 25_000 },
      ],
    });
    expect(parseMiningAttemptsApiResponse(env).submission.qpuAccessTimeUs).toBe(25_000);
  });

  test("accepts string-encoded qpu_access_time_us values", () => {
    // Some HTTP transports stringify all numeric JSON values when
    // they exceed a safe-integer threshold. The parser coerces via
    // Number() to preserve the field across that path.
    const env = envelope({
      attempts: [{ type: "attempt", iter: 1, best_energy_milli: -1, qpu_access_time_us: "84000" }],
    });
    expect(parseMiningAttemptsApiResponse(env).submission.qpuAccessTimeUs).toBe(84_000);
  });

  test("contract: key always present with null value (CPU/CUDA iteration shape)", () => {
    // Miner-side contract: the JSONL writer always emits the
    // `qpu_access_time_us` key. D-Wave iterations carry the integer
    // microsecond sum (programming_time + sampling_time); CPU /
    // CUDA / etc. iterations carry literal `null`. The parser must
    // treat null exactly like absent — contributes 0, no throw, no
    // NaN.
    const env = envelope({
      attempts: [
        { type: "attempt", iter: 1, best_energy_milli: -1, qpu_access_time_us: null },
        { type: "attempt", iter: 2, best_energy_milli: -1, qpu_access_time_us: null },
      ],
    });
    expect(parseMiningAttemptsApiResponse(env).submission.qpuAccessTimeUs).toBe(0);
  });

  test("contract: mixed-backend submission with some null iterations", () => {
    // Aggregator-mode container: a single submission can in
    // principle blend iterations from different backends. CPU/CUDA
    // iters emit null; D-Wave iters emit microseconds. Sum should
    // capture only the QPU contribution.
    const env = envelope({
      attempts: [
        { type: "attempt", iter: 1, best_energy_milli: -1, qpu_access_time_us: null },
        { type: "attempt", iter: 2, best_energy_milli: -1, qpu_access_time_us: 84_000 },
        { type: "attempt", iter: 3, best_energy_milli: -1, qpu_access_time_us: null },
        { type: "attempt", iter: 4, best_energy_milli: -1, qpu_access_time_us: 84_000 },
      ],
    });
    expect(parseMiningAttemptsApiResponse(env).submission.qpuAccessTimeUs).toBe(168_000);
  });
});

describe("parseMiningAttemptsApiResponse — numValid (sampler productivity)", () => {
  // Post-MR-!103 the miner embeds a `solution_meta` dict per iteration
  // and its `n_unique_total` is the target-blind unique-solution count
  // (the "productivity" number the Recent Performance table shows).
  // The top-level `num_valid` field now carries the target-AWARE
  // below-threshold count, so we must NOT read it as productivity for
  // !103+ miners — only as the legacy fallback for older images.

  test("prefers solution_meta.n_unique_total off the submitted iteration", () => {
    const env = envelope({
      attempts: [
        {
          type: "attempt",
          iter: 1,
          best_energy_milli: -14777000,
          result_kind: "rejected",
          num_valid: 3,
          solution_meta: { n_unique_total: 90, n_unique_below_threshold: 3 },
        },
        {
          type: "attempt",
          iter: 2,
          best_energy_milli: -14869000,
          result_kind: "submitted_inblock",
          // num_valid is the below-target count post-!103 — must be ignored.
          num_valid: 5,
          solution_meta: { n_unique_total: 112, n_unique_below_threshold: 5 },
        },
      ],
    });
    expect(parseMiningAttemptsApiResponse(env).submission.numValid).toBe(112);
  });

  test("falls back to legacy num_valid when no solution_meta (older miner)", () => {
    // Pre-!103 image: no solution_meta, and num_valid IS the
    // target-blind productivity count. Preserve that reading.
    const env = envelope({
      attempts: [
        {
          type: "attempt",
          iter: 1,
          best_energy_milli: -14869000,
          result_kind: "submitted_inblock",
          num_valid: 87,
        },
      ],
    });
    expect(parseMiningAttemptsApiResponse(env).submission.numValid).toBe(87);
  });

  test("falls back to last iteration's n_unique_total when no submit row", () => {
    // chain_error / mempool path: no row marked submitted. Use the
    // most recent iteration's productivity figure rather than 0.
    const env = envelope({
      attempts: [
        {
          type: "attempt",
          iter: 1,
          best_energy_milli: -14700000,
          result_kind: "stored",
          solution_meta: { n_unique_total: 64, n_unique_below_threshold: 0 },
        },
        {
          type: "attempt",
          iter: 2,
          best_energy_milli: -14800000,
          result_kind: "stored",
          solution_meta: { n_unique_total: 71, n_unique_below_threshold: 0 },
        },
      ],
    });
    expect(parseMiningAttemptsApiResponse(env).submission.numValid).toBe(71);
  });

  test("defaults to 0 when neither field is present", () => {
    const env = envelope({
      attempts: [{ type: "attempt", iter: 1, best_energy_milli: -1, result_kind: "stored" }],
    });
    expect(parseMiningAttemptsApiResponse(env).submission.numValid).toBe(0);
  });
});
