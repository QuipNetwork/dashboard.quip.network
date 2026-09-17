// SPDX-License-Identifier: AGPL-3.0-or-later
//! Owned admission for queued, decoding, committing, and retrying blocks.
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

/// A block cannot enter the scheduler without owning one permit.
#[derive(Clone, Debug)]
pub struct Admission {
    state: Arc<State>,
}
#[derive(Debug)]
struct State {
    total: usize,
    backfill: usize,
    active: AtomicUsize,
    backfill_active: AtomicUsize,
}
/// Capacity is unavailable or the configured reserve is invalid.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AdmissionError {
    /// All eligible slots are already owned.
    #[error("indexer admission capacity exhausted")]
    Full,
    /// Capacity must be positive and reserve cannot exceed total capacity.
    #[error("invalid indexer admission capacity")]
    InvalidCapacity,
}
/// Owned until the job commits or is explicitly abandoned to durable coverage.
#[derive(Debug)]
pub struct Permit {
    state: Arc<State>,
    backfill: bool,
}
impl Default for Admission {
    fn default() -> Self {
        Self {
            state: Arc::new(State {
                total: 64,
                backfill: 56,
                active: AtomicUsize::new(0),
                backfill_active: AtomicUsize::new(0),
            }),
        }
    }
}
impl Admission {
    /// Construct bounded admission; production uses 64 slots with eight reserved for live work.
    /// # Errors
    /// Returns `InvalidCapacity` for an empty total or an excessive reserve.
    pub fn new(total: usize, reserved_live: usize) -> Result<Self, AdmissionError> {
        if total == 0 || reserved_live > total {
            return Err(AdmissionError::InvalidCapacity);
        }
        Ok(Self {
            state: Arc::new(State {
                total,
                backfill: total - reserved_live,
                active: AtomicUsize::new(0),
                backfill_active: AtomicUsize::new(0),
            }),
        })
    }
    /// Admit live work without waiting or allocating a task.
    /// # Errors
    /// Returns `Full` when every slot is owned.
    pub fn try_live(&self) -> Result<Permit, AdmissionError> {
        claim(&self.state.active, self.state.total)?;
        Ok(Permit {
            state: self.state.clone(),
            backfill: false,
        })
    }
    /// Admit backfill only if a non-reserved slot remains.
    /// # Errors
    /// Returns `Full` when backfill or global capacity is exhausted.
    pub fn try_backfill(&self) -> Result<Permit, AdmissionError> {
        claim(&self.state.backfill_active, self.state.backfill)?;
        if let Err(error) = claim(&self.state.active, self.state.total) {
            let _ = self.state.backfill_active.fetch_sub(1, Ordering::AcqRel);
            return Err(error);
        }
        Ok(Permit {
            state: self.state.clone(),
            backfill: true,
        })
    }
    /// Number of owned global slots, including commits and retry waits.
    #[must_use]
    pub fn active(&self) -> usize {
        self.state.active.load(Ordering::Acquire)
    }
    /// Number of owned backfill slots.
    #[must_use]
    pub fn backfill_active(&self) -> usize {
        self.state.backfill_active.load(Ordering::Acquire)
    }
}
fn claim(counter: &AtomicUsize, limit: usize) -> Result<(), AdmissionError> {
    counter
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            if n < limit { Some(n + 1) } else { None }
        })
        .map(|_| ())
        .map_err(|_| AdmissionError::Full)
}
impl Drop for Permit {
    fn drop(&mut self) {
        let _ = self.state.active.fetch_sub(1, Ordering::AcqRel);
        if self.backfill {
            let _ = self.state.backfill_active.fetch_sub(1, Ordering::AcqRel);
        }
    }
}
