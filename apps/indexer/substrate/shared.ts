// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Substrate-worker constants. The shared worker primitives (WorkerContext,
// nowIso, backoffMs) live one level up in `../worker`.

export const CHAIN_HEAD_DEBOUNCE_DEFAULT_MS = 1000;

// BABE slot duration on quip-protocol-rs (spec 101); converts block-delta
// mining_time into seconds. `api.consts.babe.slotDuration` would be
// authoritative but isn't piped through telemetry yet.
export const BABE_SLOT_DURATION_SEC = 6;
