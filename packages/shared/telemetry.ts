// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Types for v0.3 dashboard. The chain (quip-protocol-rs spec >=101) is the
// canonical source for per-block PoW data via the `quantum_pow` pallet's
// `BlockWinner` + `ProofAccepted` events. The miner's `/api/v1/status` /
// `/api/v1/system` / `/api/v1/stats` REST endpoints supply self-identity and
// aggregate counters only — there is no peer-aggregation surface in v0.2/v0.3.

export * from "./telemetry/chain";
export * from "./telemetry/participation-compute";
export * from "./telemetry/miner";
export * from "./telemetry/node";
export * from "./telemetry/response";
