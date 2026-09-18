use super::{
    ChainError,
    budget::{Budget, Charge, Kind},
    invalid, make_room,
};
use jsonrpsee::{
    core::{
        client::{ClientT, SubscriptionClientT},
        params::ArrayParams,
    },
    http_client::{HttpClient, HttpClientBuilder},
    ws_client::{WsClient, WsClientBuilder},
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{Arc, Weak},
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, OnceCell, RwLock, Semaphore};

pub(super) const RESPONSE_LIMIT: u32 = 16 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// RPC admission class used to protect live capacity.
pub enum WorkClass {
    /// Live work can use all four RPC slots.
    Live,
    /// Backfill can hold at most two RPC slots.
    Backfill,
}
#[derive(Clone, Debug, Default)]
/// One RPC method's cumulative measurements.
pub struct MethodMetrics {
    /// Number of attempted RPC method calls.
    pub calls: u64,
    /// Serialized JSON result bytes, excluding transport envelope overhead.
    pub response_bytes: u64,
    /// Total RPC latency in microseconds.
    pub elapsed_micros: u128,
    /// Number of failed RPC calls.
    pub errors: u64,
}
#[derive(Clone, Debug, Default)]
/// Transport calls and shared-cache measurements.
pub struct RpcMetrics {
    /// Counters keyed by RPC method name.
    pub methods: BTreeMap<String, MethodMetrics>,
    /// Number of retained or currently shared response entries.
    pub cache_entries: usize,
    /// Reads served from a completed shared response.
    pub cache_hits: u64,
}

enum Connection {
    Http(HttpClient),
    Ws(WsClient),
}
pub(super) struct CachedResponse {
    value: Value,
    _charge: Charge,
    active_payload: Option<(
        tokio::sync::OwnedSemaphorePermit,
        Option<tokio::sync::OwnedSemaphorePermit>,
    )>,
}
impl std::ops::Deref for CachedResponse {
    type Target = Value;
    fn deref(&self) -> &Value {
        &self.value
    }
}
impl AsRef<Value> for CachedResponse {
    fn as_ref(&self) -> &Value {
        &self.value
    }
}
type Cell = Arc<OnceCell<Arc<CachedResponse>>>;
#[derive(Default)]
struct Cache {
    cells: BTreeMap<String, Cell>,
    uncached: BTreeMap<String, Weak<CachedResponse>>,
}
pub(super) struct Transport {
    endpoint: String,
    budget: Arc<Budget>,
    response_jobs: Arc<Semaphore>,
    response_backfill: Arc<Semaphore>,
    connection: RwLock<Option<Connection>>,
    calls: Semaphore,
    backfill: Semaphore,
    cache: Mutex<Cache>,
    metrics: Mutex<RpcMetrics>,
    subscriptions: Mutex<Option<HeadSubscriptions>>,
}
impl Transport {
    pub(super) fn new(endpoint: String, budget: Arc<Budget>) -> Self {
        Self {
            endpoint,
            budget,
            response_jobs: Arc::new(Semaphore::new(4)),
            response_backfill: Arc::new(Semaphore::new(2)),
            connection: RwLock::new(None),
            calls: Semaphore::new(4),
            backfill: Semaphore::new(2),
            cache: Mutex::default(),
            metrics: Mutex::default(),
            subscriptions: Mutex::default(),
        }
    }
    pub(super) async fn connect(&self) -> Result<(), ChainError> {
        let mut connection = self.connection.write().await;
        if connection.is_some() {
            return Ok(());
        }
        let next = if self.endpoint.starts_with("ws://") || self.endpoint.starts_with("wss://") {
            let build = WsClientBuilder::default()
                .max_response_size(RESPONSE_LIMIT)
                .request_timeout(REQUEST_TIMEOUT)
                .connection_timeout(Duration::from_secs(5))
                .build(&self.endpoint);
            Connection::Ws(
                tokio::time::timeout(Duration::from_secs(5), build)
                    .await
                    .map_err(|e| ChainError::Unavailable(e.to_string()))?
                    .map_err(rpc_error)?,
            )
        } else if self.endpoint.starts_with("http://") || self.endpoint.starts_with("https://") {
            Connection::Http(
                HttpClientBuilder::default()
                    .max_response_size(RESPONSE_LIMIT)
                    .request_timeout(REQUEST_TIMEOUT)
                    .build(&self.endpoint)
                    .map_err(rpc_error)?,
            )
        } else {
            return Err(ChainError::Invalid(
                "RPC URL must use HTTP(S) or WS(S)".into(),
            ));
        };
        *connection = Some(next);
        Ok(())
    }
    pub(super) async fn disconnect(&self) {
        if let Some(subscriptions) = self.subscriptions.lock().await.take() {
            for task in subscriptions.tasks {
                task.abort();
                let _ = task.await;
            }
        }
        *self.connection.write().await = None;
    }
    pub(super) async fn subscribe_heads(&self) -> Result<HeadReceivers, ChainError> {
        let mut active = self.subscriptions.lock().await;
        if let Some(active) = active.as_ref() {
            return Ok(active.receivers.clone());
        }
        let connection = self.connection.read().await;
        let Some(Connection::Ws(client)) = connection.as_ref() else {
            return Err(ChainError::Unsupported(
                "head subscriptions require a WS endpoint".into(),
            ));
        };
        let mut tasks = Vec::new();
        let mut receivers = Vec::new();
        for (subscribe, unsubscribe) in [
            ("chain_subscribeNewHeads", "chain_unsubscribeNewHeads"),
            (
                "chain_subscribeFinalizedHeads",
                "chain_unsubscribeFinalizedHeads",
            ),
        ] {
            let _call = self.calls.acquire().await.map_err(invalid)?;
            let subscription = client
                .subscribe::<super::Header, _>(subscribe, ArrayParams::new(), unsubscribe)
                .await;
            let mut subscription = match subscription {
                Ok(s) => s,
                Err(error) => {
                    for task in tasks {
                        tokio::task::JoinHandle::abort(&task);
                    }
                    return Err(rpc_error(error));
                }
            };
            let (sender, receiver) = tokio::sync::watch::channel(None);
            tasks.push(tokio::spawn(async move {
                while let Some(head) = subscription.next().await {
                    if sender.send(Some(head.map_err(invalid))).is_err() {
                        return;
                    }
                }
                let _ = sender.send(Some(Err(ChainError::Disconnected)));
            }));
            receivers.push(receiver);
        }
        let mut receivers = receivers.into_iter();
        let receivers = HeadReceivers {
            best: receivers.next().ok_or(ChainError::Disconnected)?,
            finalized: receivers.next().ok_or(ChainError::Disconnected)?,
        };
        *active = Some(HeadSubscriptions {
            receivers: receivers.clone(),
            tasks,
        });
        Ok(receivers)
    }
    pub(super) async fn metrics(&self) -> RpcMetrics {
        let cache = self.cache.lock().await;
        let count = cache.cells.len()
            + cache
                .uncached
                .values()
                .filter(|value| value.strong_count() > 0)
                .count();
        let mut metrics = self.metrics.lock().await.clone();
        metrics.cache_entries = count;
        metrics
    }
    pub(super) async fn request(
        &self,
        method: &str,
        params: Value,
        class: WorkClass,
    ) -> Result<Value, ChainError> {
        // Acquire the backfill sub-budget first: waiting backfill never owns a live slot.
        let _backfill = match class {
            WorkClass::Live => None,
            WorkClass::Backfill => Some(self.backfill.acquire().await.map_err(invalid)?),
        };
        let _call = self.calls.acquire().await.map_err(invalid)?;
        let connection = self.connection.read().await;
        let connection = connection.as_ref().ok_or(ChainError::Disconnected)?;
        let Value::Array(values) = params else {
            return Err(ChainError::Invalid(
                "RPC parameters must be an array".into(),
            ));
        };
        let mut params = ArrayParams::new();
        for value in values {
            params.insert(value).map_err(invalid)?;
        }
        let started = Instant::now();
        let result: Result<Value, ChainError> = match connection {
            Connection::Http(client) => client.request(method, params).await.map_err(rpc_error),
            Connection::Ws(client) => client.request(method, params).await.map_err(rpc_error),
        };
        let bytes = result.as_ref().map_or(0, |v| v.to_string().len());
        let mut metrics = self.metrics.lock().await;
        let metric = metrics.methods.entry(method.into()).or_default();
        metric.calls += 1;
        metric.response_bytes += bytes as u64;
        metric.elapsed_micros += started.elapsed().as_micros();
        if result.is_err() {
            metric.errors += 1;
        }
        drop(metrics);
        result
    }
    pub(super) async fn shared(
        &self,
        method: &str,
        params: Value,
        class: WorkClass,
    ) -> Result<Arc<CachedResponse>, ChainError> {
        let key = format!("{method}:{params}");
        let cell = {
            let mut cache = self.cache.lock().await;
            cache.uncached.retain(|_, value| value.strong_count() > 0);
            if let Some(value) = cache.uncached.get(&key).and_then(Weak::upgrade) {
                return Ok(value);
            }
            let limit = 128 - cache.uncached.len();
            if !cache.cells.contains_key(&key) {
                make_room(&mut cache.cells, limit, |c| Arc::strong_count(c) == 1)?;
            }
            cache.cells.entry(key.clone()).or_default().clone()
        };
        if cell.get().is_some() {
            self.metrics.lock().await.cache_hits += 1;
        }
        let result = cell
            .get_or_try_init(|| async {
                // Bound uncached payload ownership before fetching any response bytes.
                let backfill = match class {
                    WorkClass::Live => None,
                    WorkClass::Backfill => Some(
                        self.response_backfill
                            .clone()
                            .acquire_owned()
                            .await
                            .map_err(invalid)?,
                    ),
                };
                let active = self
                    .response_jobs
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(invalid)?;
                let value = self.request(method, params, class).await?;
                let bytes = value.to_string().len();
                if bytes > Kind::Response.limit() {
                    let charge = self
                        .budget
                        .reserve(Kind::Active, bytes)
                        .ok_or(ChainError::Busy)?;
                    return Ok(Arc::new(CachedResponse {
                        value,
                        _charge: charge,
                        active_payload: Some((active, backfill)),
                    }));
                }
                let mut cache = self.cache.lock().await;
                let charge = loop {
                    if let Some(charge) = self.budget.reserve(Kind::Response, bytes) {
                        break charge;
                    }
                    let removable = cache
                        .cells
                        .iter()
                        .find(|(_, entry)| Arc::strong_count(entry) == 1)
                        .map(|(key, _)| key.clone())
                        .ok_or(ChainError::Busy)?;
                    let _ = cache.cells.remove(&removable);
                };
                Ok::<_, ChainError>(Arc::new(CachedResponse {
                    value,
                    _charge: charge,
                    active_payload: None,
                }))
            })
            .await
            .cloned();
        if let Ok(response) = &result
            && response.active_payload.is_some()
        {
            let mut cache = self.cache.lock().await;
            if cache
                .cells
                .get(&key)
                .is_some_and(|entry| Arc::ptr_eq(entry, &cell))
            {
                let _ = cache.cells.remove(&key);
                let _ = cache.uncached.insert(key.clone(), Arc::downgrade(response));
            }
        }
        // A failed or cancelled load does not become immutable negative data.
        if result.is_err() {
            let mut cache = self.cache.lock().await;
            if cache.cells.get(&key).is_some_and(|c| Arc::ptr_eq(c, &cell)) {
                let _ = cache.cells.remove(&key);
            }
        }
        result
    }
}
#[expect(
    clippy::needless_pass_by_value,
    reason = "An owned error conversion fits each asynchronous RPC map_err boundary."
)]
fn rpc_error(error: jsonrpsee::core::client::Error) -> ChainError {
    let text = error.to_string();
    let lower = text.to_ascii_lowercase();
    if lower.contains("state already discarded")
        || lower.contains("state is not available")
        || lower.contains("unknown block: state")
        || lower.contains("state has been pruned")
    {
        return ChainError::Pruned(text);
    }
    if lower.contains("too large")
        || lower.contains("too big")
        || lower.contains("exceed") && (lower.contains("size") || lower.contains("length"))
    {
        return ChainError::Oversized(text);
    }
    if let jsonrpsee::core::client::Error::Call(ref object) = error {
        if object.code() == -32601 {
            return ChainError::Unsupported(text);
        }
        return if object.code() == -32602 {
            ChainError::Invalid(text)
        } else {
            ChainError::Unavailable(text)
        };
    }
    ChainError::Unavailable(text)
}

/// Bounded, coalesced head notifications. The indexer recovers skipped heights from coverage.
#[derive(Clone)]
pub struct HeadReceivers {
    /// Coalesced best-head notifications.
    pub best: tokio::sync::watch::Receiver<Option<Result<super::Header, ChainError>>>,
    /// Coalesced finalized-head notifications.
    pub finalized: tokio::sync::watch::Receiver<Option<Result<super::Header, ChainError>>>,
}
struct HeadSubscriptions {
    receivers: HeadReceivers,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
