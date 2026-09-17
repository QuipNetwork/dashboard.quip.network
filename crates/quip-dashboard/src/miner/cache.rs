// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded singleflight resource caches with reservations owned by returned data.

use super::parse::{MinerError, format_iso8601_ms};
use serde::Serialize;
use std::{collections::HashMap, future::Future, sync::Arc};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::time::{Duration, Instant};

pub(super) const CACHE_BYTES: usize = 6 * 1024 * 1024;
const ENTRIES: usize = 32;

/// A fetched resource whose reservation lasts until its final shared owner drops.
#[derive(Debug)]
pub struct Observed<T> {
    /// Parsed miner data.
    pub data: T,
    /// UTC observation time with millisecond precision.
    pub observed_at: String,
    _reservation: OwnedSemaphorePermit,
}

struct Entry<T> {
    expires: Instant,
    result: Result<Arc<Observed<T>>, MinerError>,
}

type Slot<T> = Arc<Mutex<Option<Entry<T>>>>;

pub(super) struct Cache<T> {
    entries: Mutex<HashMap<String, (Instant, Slot<T>)>>,
    budget: Arc<Semaphore>,
}

impl<T: Serialize> Cache<T> {
    pub(super) fn new(budget: Arc<Semaphore>) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            budget,
        }
    }

    pub(super) async fn prune_expired(&self) {
        let now = Instant::now();
        self.entries.lock().await.retain(|_, (_, slot)| {
            // A waiter or fetch leader owns another slot reference. Leave its
            // singleflight state intact, and never wait for a resource lock.
            if Arc::strong_count(slot) > 1 {
                return true;
            }
            let Ok(entry) = slot.try_lock() else {
                return true;
            };
            entry.as_ref().is_some_and(|entry| entry.expires > now)
        });
    }

    pub(super) async fn get<F, Fut>(
        &self,
        key: String,
        peer: bool,
        fetch: F,
    ) -> Result<Arc<Observed<T>>, MinerError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, MinerError>>,
    {
        let slot = {
            let mut entries = self.entries.lock().await;
            if let Some((used, slot)) = entries.get_mut(&key) {
                *used = Instant::now();
                Arc::clone(slot)
            } else {
                if entries.len() >= ENTRIES {
                    let oldest = entries
                        .iter()
                        .filter(|(_, (_, slot))| Arc::strong_count(slot) == 1)
                        .min_by_key(|(_, (used, _))| *used)
                        .map(|(key, _)| key.clone());
                    if let Some(oldest) = oldest {
                        let _ = entries.remove(&oldest);
                    } else {
                        return Err(MinerError::Http("miner resource capacity exhausted".into()));
                    }
                }
                let slot = Arc::new(Mutex::new(None));
                let _ = entries.insert(key, (Instant::now(), Arc::clone(&slot)));
                slot
            }
        };
        let mut entry = slot.lock().await;
        if let Some(cached) = entry.as_ref()
            && cached.expires > Instant::now()
        {
            return cached.result.clone();
        }
        // Release this cache's stale ownership before fetching its replacement.
        *entry = None;
        let result = match fetch().await {
            Ok(data) => self.observe(data).await,
            Err(error) => Err(bounded_error(error)),
        };
        let ttl = if !peer {
            8
        } else if result.is_ok() {
            5
        } else {
            60
        };
        *entry = Some(Entry {
            expires: Instant::now() + Duration::from_secs(ttl),
            result: result.clone(),
        });
        result
    }

    async fn observe(&self, data: T) -> Result<Arc<Observed<T>>, MinerError> {
        // JSON tree storage is a conservative charge for the equivalent typed DTO:
        // include all node slots, string allocations, and map-node overhead.
        let value = serde_json::to_value(&data)
            .map_err(|error| MinerError::Unparsable(error.to_string()))?;
        let bytes = retained_bytes(&value).saturating_add(size_of::<Observed<T>>() + 64);
        drop(value);
        if bytes > CACHE_BYTES {
            return Err(MinerError::BodyTooLarge { cap: CACHE_BYTES });
        }
        let count =
            u32::try_from(bytes).map_err(|_| MinerError::BodyTooLarge { cap: CACHE_BYTES })?;
        let reservation =
            if let Ok(reservation) = Arc::clone(&self.budget).try_acquire_many_owned(count) {
                reservation
            } else {
                // Only idle slots may be discarded; outstanding Arcs retain their
                // reservations, including after this eviction.
                self.entries
                    .lock()
                    .await
                    .retain(|_, (_, slot)| Arc::strong_count(slot) > 1);
                Arc::clone(&self.budget)
                    .try_acquire_many_owned(count)
                    .map_err(|_| MinerError::BodyTooLarge { cap: CACHE_BYTES })?
            };
        let unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| MinerError::Http(error.to_string()))?
            .as_millis();
        let observed_at = format_iso8601_ms(u64::try_from(unix_ms).unwrap_or(u64::MAX));
        Ok(Arc::new(Observed {
            data,
            observed_at,
            _reservation: reservation,
        }))
    }
}

fn bounded_error(mut error: MinerError) -> MinerError {
    let message = match &mut error {
        MinerError::Unparsable(message)
        | MinerError::Unreachable(message)
        | MinerError::EnvelopeFailure(message)
        | MinerError::Http(message) => Some(message),
        MinerError::NotFound(_)
        | MinerError::RateLimited
        | MinerError::UpstreamStatus(_)
        | MinerError::MissingLocalUrl
        | MinerError::BodyTooLarge { .. }
        | MinerError::InvalidSolutionNumber => None,
    };
    if let Some(message) = message
        && message.len() > 512
    {
        let end = message.floor_char_boundary(512);
        message.truncate(end);
        message.shrink_to_fit();
    }
    error
}

fn retained_bytes(value: &serde_json::Value) -> usize {
    use serde_json::Value;
    size_of::<Value>().saturating_add(match value {
        Value::Null | Value::Bool(_) => 0,
        Value::Number(number) => number.to_string().len(),
        Value::String(string) => string.capacity(),
        Value::Array(values) => values
            .iter()
            .map(retained_bytes)
            .sum::<usize>()
            .saturating_add(values.capacity().saturating_sub(values.len()) * size_of::<Value>()),
        Value::Object(values) => values
            .iter()
            .map(|(key, value)| {
                key.capacity()
                    .saturating_add(retained_bytes(value))
                    .saturating_add(96)
            })
            .sum(),
    })
}
