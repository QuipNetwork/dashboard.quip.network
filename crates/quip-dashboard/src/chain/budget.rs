use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

/// Retained payload accounting. Allocator and decoded metadata overhead are separate.
#[derive(Clone, Copy, Debug, Default)]
pub struct PayloadMetrics {
    /// Charged JSON response bytes, including values held by consumers.
    pub response_bytes: usize,
    /// Charged SCALE metadata bytes, including metadata referenced by blocks.
    pub metadata_bytes: usize,
    /// Conservative owned payload estimate for retained decoded blocks.
    pub block_bytes: usize,
    /// Active uncached response and block bytes, each bounded by four 16 MiB values.
    pub in_flight_bytes: usize,
    /// Maximum total charge observed since reader creation.
    pub peak_bytes: usize,
}
#[derive(Clone, Copy, Debug)]
pub(super) enum Kind {
    Response,
    Metadata,
    Block,
    Active,
    ActiveBlock,
}
impl Kind {
    pub(super) fn limit(self) -> usize {
        match self {
            Self::Response => 12 * 1024 * 1024,
            Self::Metadata => 8 * 1024 * 1024,
            Self::Block => 4 * 1024 * 1024,
            Self::Active | Self::ActiveBlock => 64 * 1024 * 1024,
        }
    }
}
#[derive(Debug, Default)]
pub(super) struct Budget {
    response: AtomicUsize,
    metadata: AtomicUsize,
    block: AtomicUsize,
    peak: AtomicUsize,
    active: AtomicUsize,
    active_block: AtomicUsize,
}
#[derive(Debug)]
pub(super) struct Charge {
    budget: Arc<Budget>,
    kind: Kind,
    bytes: usize,
}
impl Budget {
    fn counter(&self, kind: Kind) -> &AtomicUsize {
        match kind {
            Kind::Response => &self.response,
            Kind::Metadata => &self.metadata,
            Kind::Block => &self.block,
            Kind::Active => &self.active,
            Kind::ActiveBlock => &self.active_block,
        }
    }
    pub(super) fn reserve(self: &Arc<Self>, kind: Kind, bytes: usize) -> Option<Charge> {
        let _ = self
            .counter(kind)
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                used.checked_add(bytes).filter(|next| *next <= kind.limit())
            })
            .ok()?;
        let total = self.response.load(Ordering::SeqCst)
            + self.metadata.load(Ordering::SeqCst)
            + self.block.load(Ordering::SeqCst);
        let _ = self.peak.fetch_max(total, Ordering::SeqCst);
        Some(Charge {
            budget: self.clone(),
            kind,
            bytes,
        })
    }
    pub(super) fn metrics(&self) -> PayloadMetrics {
        PayloadMetrics {
            response_bytes: self.response.load(Ordering::SeqCst),
            metadata_bytes: self.metadata.load(Ordering::SeqCst),
            block_bytes: self.block.load(Ordering::SeqCst),
            peak_bytes: self.peak.load(Ordering::SeqCst),
            in_flight_bytes: self.active.load(Ordering::SeqCst)
                + self.active_block.load(Ordering::SeqCst),
        }
    }
}
impl Drop for Charge {
    fn drop(&mut self) {
        let _ = self
            .budget
            .counter(self.kind)
            .fetch_sub(self.bytes, Ordering::SeqCst);
    }
}
