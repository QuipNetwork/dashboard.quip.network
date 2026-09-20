// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared miner REST access, typed parsing, and bounded resource caches.

mod cache;
mod client;
pub mod parse;
mod stream;

use cache::Cache;
pub use cache::Observed;
use client::MinerClient;
use parse::{
    CurrentDispatch, MinerError, MinerStats, MiningAttemptsResponse, NodeStatus, PeerHost,
};
use std::{future::Future, pin::Pin, sync::Arc};
use tokio::sync::Semaphore;

/// Trusted access to descriptor hosts persisted by the chain indexer.
pub trait PeerResolver: Send + Sync {
    /// Resolve an account through persisted descriptor data, never request URLs.
    fn resolve<'a>(
        &'a self,
        account: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<PeerHost>, MinerError>> + Send + 'a>>;
}

/// Independent local or peer observations; partial failures remain explicit.
#[derive(Debug, Clone)]
pub struct MinerSnapshot {
    /// Miner identity and mode data.
    pub status: Result<Arc<Observed<NodeStatus>>, MinerError>,
    /// Aggregate controller counters.
    pub stats: Result<Arc<Observed<MinerStats>>, MinerError>,
}

/// Shared client and bounded caches for all miner consumers.
pub struct MinerService {
    local_url: Option<String>,
    resolver: Arc<dyn PeerResolver>,
    client: MinerClient,
    budget: Arc<Semaphore>,
    endpoints: Cache<String>,
    status: Cache<NodeStatus>,
    stats: Cache<MinerStats>,
    attempts: Cache<MiningAttemptsResponse>,
    dispatch: Cache<Option<CurrentDispatch>>,
    dispatch_attempts: Cache<Vec<parse::MiningAttempt>>,
}

impl MinerService {
    /// Build the shared service with separate local REST configuration.
    ///
    /// # Errors
    /// Returns an error if the HTTP client cannot be built.
    pub fn new(
        local_url: Option<String>,
        resolver: Arc<dyn PeerResolver>,
    ) -> Result<Self, MinerError> {
        let budget = Arc::new(Semaphore::new(cache::CACHE_BYTES));
        Ok(Self {
            local_url: local_url.filter(|url| !url.trim().is_empty()),
            resolver,
            client: MinerClient::new()?,
            endpoints: Cache::new(Arc::clone(&budget)),
            status: Cache::new(Arc::clone(&budget)),
            stats: Cache::new(Arc::clone(&budget)),
            attempts: Cache::new(Arc::clone(&budget)),
            dispatch: Cache::new(Arc::clone(&budget)),
            dispatch_attempts: Cache::new(Arc::clone(&budget)),
            budget,
        })
    }

    /// Charged retained payload bytes, including observations held after eviction.
    #[must_use]
    pub fn retained_bytes(&self) -> usize {
        cache::CACHE_BYTES - self.budget.available_permits()
    }

    /// Fetch or share the local status and statistics for at least eight seconds.
    pub async fn local_snapshot(&self) -> MinerSnapshot {
        self.prune_expired().await;
        match self.local_url.as_deref() {
            Some(base) => self.snapshot(base, false).await,
            None => unavailable(MinerError::MissingLocalUrl),
        }
    }

    /// Fetch or share a peer resolved exclusively through its persisted descriptor.
    pub async fn peer_snapshot(&self, account: &str) -> MinerSnapshot {
        self.prune_expired().await;
        match self.endpoint(account).await {
            Ok(base) => self.snapshot(&base.data, true).await,
            Err(error) => unavailable(error),
        }
    }

    /// Fetch the local submission detail while preserving upstream errors.
    ///
    /// # Errors
    /// Returns validation, HTTP, parsing, or capacity errors.
    pub async fn local_attempts(
        &self,
        solution_number: u64,
    ) -> Result<Arc<Observed<MiningAttemptsResponse>>, MinerError> {
        self.prune_expired().await;
        self.attempts(
            self.local_url
                .as_deref()
                .ok_or(MinerError::MissingLocalUrl)?,
            solution_number,
            false,
        )
        .await
    }

    /// Fetch submission detail from a descriptor-resolved peer.
    ///
    /// # Errors
    /// Returns resolution, validation, HTTP, parsing, or capacity errors.
    pub async fn peer_attempts(
        &self,
        account: &str,
        solution_number: u64,
    ) -> Result<Arc<Observed<MiningAttemptsResponse>>, MinerError> {
        self.prune_expired().await;
        let base = self.endpoint(account).await?;
        self.attempts(&base.data, solution_number, true).await
    }

    /// Resolve the local in-flight or just-completed dispatch.
    ///
    /// # Errors
    /// Returns configuration, status, or upstream errors when no trail can be read.
    pub async fn local_dispatch(
        &self,
        solution_number: i64,
    ) -> Result<Arc<Observed<Option<CurrentDispatch>>>, MinerError> {
        self.prune_expired().await;
        self.dispatch(
            self.local_url
                .as_deref()
                .ok_or(MinerError::MissingLocalUrl)?,
            solution_number,
            false,
        )
        .await
    }

    /// Resolve a peer dispatch using its persisted descriptor and declared miner id.
    ///
    /// # Errors
    /// Returns resolution, status, or upstream errors when no trail can be read.
    pub async fn peer_dispatch(
        &self,
        account: &str,
        solution_number: i64,
    ) -> Result<Arc<Observed<Option<CurrentDispatch>>>, MinerError> {
        self.prune_expired().await;
        let base = self.endpoint(account).await?;
        self.dispatch(&base.data, solution_number, true).await
    }

    async fn prune_expired(&self) {
        // All caches draw from one reservation pool. Reclaim stale ownership
        // across resource types even if their consumers never request them again.
        self.endpoints.prune_expired().await;
        self.status.prune_expired().await;
        self.stats.prune_expired().await;
        self.attempts.prune_expired().await;
        self.dispatch.prune_expired().await;
        self.dispatch_attempts.prune_expired().await;
    }

    async fn endpoint(&self, account: &str) -> Result<Arc<Observed<String>>, MinerError> {
        if account.len() > 256 {
            return Err(MinerError::Http("account identifier too long".into()));
        }
        self.endpoints
            .get(account.to_owned(), true, || async {
                let host = self.resolver.resolve(account).await?;
                parse::resolve_peer_miner_rest_url(host.as_ref())
                    .filter(|url| url.len() <= 2048)
                    .ok_or_else(|| {
                        MinerError::Unreachable("peer descriptor has no REST host".into())
                    })
            })
            .await
    }

    async fn snapshot(&self, base: &str, peer: bool) -> MinerSnapshot {
        let (status, stats) = tokio::join!(
            self.status(base, peer),
            self.stats.get(key(base, peer), peer, || async {
                let raw = self.client.json(base, "/api/v1/stats", &[], peer).await?;
                Ok(parse::parse_miner_stats_payload(&raw))
            })
        );
        MinerSnapshot { status, stats }
    }

    async fn status(
        &self,
        base: &str,
        peer: bool,
    ) -> Result<Arc<Observed<NodeStatus>>, MinerError> {
        self.status
            .get(key(base, peer), peer, || async {
                let raw = self.client.json(base, "/api/v1/status", &[], peer).await?;
                Ok(parse::parse_node_status(&raw))
            })
            .await
    }

    async fn attempts(
        &self,
        base: &str,
        solution: u64,
        peer: bool,
    ) -> Result<Arc<Observed<MiningAttemptsResponse>>, MinerError> {
        if solution == 0 || solution > 9_007_199_254_740_991 {
            return Err(MinerError::InvalidSolutionNumber);
        }
        let miner_solution = miner_solution_number(solution)?;
        self.attempts
            .get(format!("{}:{solution}", key(base, peer)), peer, || async {
                let body = self
                    .client
                    .attempts(
                        base,
                        &[("solution_number", miner_solution.to_string())],
                        peer,
                    )
                    .await
                    .map_err(|error| chain_numbered(error, solution))?;
                let mut parsed =
                    parse::mining_attempts_from_parts(body.submission.as_ref(), body.trail)?;
                if parsed.submission.solution_number
                    != i64::try_from(miner_solution).unwrap_or(i64::MAX)
                {
                    return Err(MinerError::Unparsable(
                        "miner returned a different solution number".into(),
                    ));
                }
                parsed.submission.solution_number = i64::try_from(solution).unwrap_or(i64::MAX);
                chain_number_attempts(&mut parsed.attempts, solution);
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|error| MinerError::Http(error.to_string()))?
                    .as_millis();
                parsed.submission.observed_at =
                    parse::format_iso8601_ms(u64::try_from(now).unwrap_or(u64::MAX));
                Ok(parsed)
            })
            .await
    }

    async fn dispatch(
        &self,
        base: &str,
        solution: i64,
        peer: bool,
    ) -> Result<Arc<Observed<Option<CurrentDispatch>>>, MinerError> {
        if solution <= 0 || solution > 9_007_199_254_740_991 {
            return Err(MinerError::InvalidSolutionNumber);
        }
        let status = self.status(base, peer).await?;
        let miner_id = status
            .data
            .miners
            .first()
            .map(|miner| miner.id.as_str())
            .unwrap_or_default();
        self.dispatch
            .get(
                format!("{}:{solution}:{miner_id}", key(base, peer)),
                peer,
                || async {
                    if miner_id.is_empty() {
                        return Ok(None);
                    }
                    let current = self.dispatch_attempts(base, miner_id, solution, peer).await;
                    let previous = if solution > 1 {
                        self.dispatch_attempts(base, miner_id, solution - 1, peer)
                            .await
                            .map(Some)
                    } else {
                        Ok(None)
                    };
                    // Preserve usable partial trails, but never turn two failed probes into
                    // a positively cached empty dispatch.
                    if let Ok(current) = &current
                        && !current.data.is_empty()
                    {
                        return Ok(parse::select_current_dispatch(
                            solution,
                            current.data.clone(),
                            Vec::new(),
                        ));
                    }
                    if let Ok(Some(previous)) = &previous
                        && !previous.data.is_empty()
                    {
                        return Ok(parse::select_current_dispatch(
                            solution,
                            Vec::new(),
                            previous.data.clone(),
                        ));
                    }
                    let _ = current?;
                    let _ = previous?;
                    Ok(None)
                },
            )
            .await
    }

    async fn dispatch_attempts(
        &self,
        base: &str,
        miner_id: &str,
        solution: i64,
        peer: bool,
    ) -> Result<Arc<Observed<Vec<parse::MiningAttempt>>>, MinerError> {
        let solution = u64::try_from(solution).map_err(|_| MinerError::InvalidSolutionNumber)?;
        let miner_solution = miner_solution_number(solution)?;
        self.dispatch_attempts
            .get(
                format!("{}:{miner_id}:{solution}", key(base, peer)),
                peer,
                || async {
                    let body = self
                        .client
                        .attempts(
                            base,
                            &[
                                ("miner_id", miner_id.to_owned()),
                                ("solution_number", miner_solution.to_string()),
                            ],
                            peer,
                        )
                        .await
                        .map_err(|error| chain_numbered(error, solution))?;
                    let mut attempts = body.trail.into_newest();
                    chain_number_attempts(&mut attempts, solution);
                    Ok(attempts)
                },
            )
            .await
    }
}

/// The miner files a solution's attempts under the id of the last accepted
/// qblock (`QuantumPowApi_latest_qblock_id`), which is one below the chain id
/// that the solution competes for. The dashboard uses chain ids everywhere
/// and translates only here. Chain qblock 1 predates any accepted qblock, so
/// the miner has no number for it.
fn miner_solution_number(chain_qblock: u64) -> Result<u64, MinerError> {
    chain_qblock
        .checked_sub(1)
        .filter(|number| *number > 0)
        .ok_or(MinerError::NotFound(chain_qblock))
}

/// Rewrite each row's miner `solution_number` to the chain qblock id.
fn chain_number_attempts(attempts: &mut [parse::MiningAttempt], chain_qblock: u64) {
    for attempt in attempts {
        if let Some(number) = attempt.extra.get_mut("solution_number") {
            *number = chain_qblock.into();
        }
    }
}

/// Report a miner 404 under the chain qblock id the caller asked for.
fn chain_numbered(error: MinerError, chain_qblock: u64) -> MinerError {
    match error {
        MinerError::NotFound(_) => MinerError::NotFound(chain_qblock),
        other => other,
    }
}

fn key(base: &str, peer: bool) -> String {
    format!("{peer}:{base}")
}
fn unavailable(error: MinerError) -> MinerSnapshot {
    MinerSnapshot {
        status: Err(error.clone()),
        stats: Err(error),
    }
}
