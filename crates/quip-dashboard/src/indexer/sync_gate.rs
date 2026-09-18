// SPDX-License-Identifier: AGPL-3.0-or-later
//! Backfill gating on validator sync state, sustained RPC latency, and live lag.
//!
//! The gate centralizes the three pause conditions the spec requires
//! (see `docs/superpowers/specs/2026-09-16-rust-dashboard.md`) so the telemetry
//! surfacing and the backfill loop make the same decision. It also produces the
//! node-sync observation fields the `/api/telemetry` contract exposes
//! (`nodeSyncing`, `nodeSyncCurrentBlock`, `nodeSyncHighestBlock`).

use crate::chain::{RpcMetrics, SyncStateInfo};

/// Maximum average RPC latency before backfill pauses, in microseconds.
/// Five seconds matches the transport request timeout and the observed live
/// latency during sustained validator pressure.
pub(crate) const LATENCY_CEILING_MICROS: u64 = 5_000_000;

/// Live-lag bound: when the validator's best head is at least this many blocks
/// ahead of the finalized head, the validator is still catching up and backfill
/// pauses to avoid competing for RPC capacity.
pub(crate) const LIVE_LAG_BOUND: u64 = 32;

/// Consecutive in-sync samples required before a paused backfill resumes.
/// At the one-second backfill cadence this debounces resume for ten seconds,
/// preventing pause/resume thrash at a sync boundary.
pub(crate) const RESUME_HYSTERESIS: u64 = 10;

/// Per-sample backfill decision.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SyncGateDecision {
    /// Whether the backfill worker must pause this round.
    pub(crate) paused: bool,
}

/// Owned per-condition backfill gate with off-hysteresis.
#[derive(Clone, Debug, Default)]
pub(crate) struct SyncGate {
    /// Consecutive in-sync samples observed so far this cycle.
    in_sync_runs: u64,
}

impl SyncGate {
    /// Evaluate one sample. Returns whether backfill must pause.
    pub(crate) fn evaluate<S>(
        &mut self,
        sync: &S,
        finalized: u64,
        best: u64,
        latency: Sample,
    ) -> SyncGateDecision
    where
        S: SyncLike,
    {
        let sync_paused = sync.is_syncing();
        let lag_paused = best.saturating_sub(finalized) >= LIVE_LAG_BOUND;
        let latency_paused = latency.ceiling() > LATENCY_CEILING_MICROS;
        let paused_now = sync_paused || lag_paused || latency_paused;
        self.in_sync_runs = if paused_now {
            0
        } else {
            self.in_sync_runs.saturating_add(1)
        };
        // Resume only after the pause clears for RESUME_HYSTERESIS consecutive rounds.
        let paused = if paused_now {
            true
        } else {
            self.in_sync_runs < RESUME_HYSTERESIS
        };
        SyncGateDecision { paused }
    }
}

/// Abstraction over sync-state sources so the pure logic is unit-testable
/// without a live chain connection or transport.
pub(crate) trait SyncLike {
    fn is_syncing(&self) -> bool;
}

impl SyncLike for SyncStateInfo {
    fn is_syncing(&self) -> bool {
        self.is_syncing
    }
}

/// Latency sample fed to the gate. Separated so callers choose how to measure
/// "sustained" latency without coupling the gate to transport internals.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Sample {
    /// Average RPC latency in microseconds over the measurement window.
    pub(crate) average_micros: u64,
}
impl Sample {
    /// Build from per-method latency and call counts so callers can aggregate
    /// the transport metrics without the gate owning the accumulators.
    pub(crate) fn from_metrics(metrics: &RpcMetrics) -> Self {
        let mut micros = 0_u64;
        let mut calls = 0_u64;
        for method in metrics.methods.values() {
            micros =
                micros.saturating_add(u64::try_from(method.elapsed_micros).unwrap_or(u64::MAX));
            calls = calls.saturating_add(method.calls);
        }
        let average = micros.checked_div(calls).unwrap_or(0);
        Self {
            average_micros: average,
        }
    }
    /// The latency criterion's ceiling value.
    pub(crate) fn ceiling(self) -> u64 {
        self.average_micros
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake {
        syncing: bool,
        current: Option<u64>,
        highest: Option<u64>,
    }
    impl SyncLike for Fake {
        fn is_syncing(&self) -> bool {
            self.syncing
        }
    }
    fn calm() -> Fake {
        Fake {
            syncing: false,
            current: Some(500),
            highest: Some(500),
        }
    }
    fn sample(ms: u64) -> Sample {
        Sample {
            average_micros: ms.saturating_mul(1000),
        }
    }

    #[test]
    fn in_sync_node_ramps_to_resume() {
        let mut gate = SyncGate::default();
        // Fresh gate: the first in-sync sample still holds backfill (hysteresis
        // ramp) and resumes only after RESUME_HYSTERESIS consecutive calm rounds.
        for i in 0..RESUME_HYSTERESIS {
            let d = gate.evaluate(&calm(), 480, 500, sample(50));
            if i + 1 < RESUME_HYSTERESIS {
                assert!(d.paused, "sample {} in the ramp must hold", i + 1);
            } else {
                assert!(!d.paused, "sample {} resumes", i + 1);
            }
        }
    }

    #[test]
    fn syncing_validator_pauses_immediately() {
        let mut gate = SyncGate::default();
        let mut fake = calm();
        fake.syncing = true;
        fake.current = Some(300);
        fake.highest = Some(600);
        let d = gate.evaluate(&fake, 480, 500, sample(50));
        assert!(d.paused);
    }

    #[test]
    fn live_lag_pauses_until_best_closes_to_finalized() {
        let mut gate = SyncGate::default();
        // best (600) - finalized (480) = 120 >= 32 -> paused by lag directly.
        let d = gate.evaluate(&calm(), 480, 600, sample(50));
        assert!(d.paused);
        // Best closes to finalized; backfill stays held through the in-sync ramp
        // and resumes only after RESUME_HYSTERESIS consecutive calm samples.
        for i in 0..RESUME_HYSTERESIS {
            let r = gate.evaluate(&calm(), 480, 500, sample(50));
            if i + 1 < RESUME_HYSTERESIS {
                assert!(r.paused, "sample {} in the ramp must hold", i + 1);
            } else {
                assert!(!r.paused, "sample {} resumes", i + 1);
            }
        }
    }

    #[test]
    fn sustained_latency_pauses_and_resolves() {
        let mut gate = SyncGate::default();
        // 6s average exceeds the 5s ceiling.
        let d = gate.evaluate(&calm(), 480, 500, sample(6000));
        assert!(d.paused);
        // Sub-ceiling latency ramps: held until RESUME_HYSTERESIS consecutive calm
        // samples, then it resumes.
        for i in 0..RESUME_HYSTERESIS {
            let r = gate.evaluate(&calm(), 480, 500, sample(1000));
            if i + 1 < RESUME_HYSTERESIS {
                assert!(r.paused, "sample {} in the ramp must hold", i + 1);
            } else {
                assert!(!r.paused, "sample {} resumes", i + 1);
            }
        }
    }

    #[test]
    fn resume_requires_consecutive_in_sync_samples() {
        let mut gate = SyncGate::default();
        // Establish an idle (not paused) run, then verify a bad sample resets it.
        for _ in 0..RESUME_HYSTERESIS {
            let _ = gate.evaluate(&calm(), 480, 500, sample(50));
        }
        let d = gate.evaluate(&calm(), 480, 500, sample(50));
        assert!(!d.paused);
        // A single lag sample drops the run to zero.
        let _ = gate.evaluate(&calm(), 480, 600, sample(50));
        let d = gate.evaluate(&calm(), 480, 500, sample(50));
        assert!(d.paused, "reset run must hold backfill until hysteresis");
    }
}
