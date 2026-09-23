// SPDX-License-Identifier: AGPL-3.0-or-later
//! One bounded HTTP client shared by local polling and peer requests.

use super::parse::{MinerError, unwrap_envelope};
use super::stream::{self, AttemptsBody};
use reqwest::{Client, Response, Url};
use serde_json::Value;
use std::{collections::HashMap, future::Future, io::Read};
use tokio::{
    sync::{Mutex, Semaphore, mpsc},
    time::{Duration, Instant},
};

pub(super) const RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// Wire cap for a streamed attempts body. Memory stays bounded by the fold,
/// so this only bounds download time; it covers roughly 200,000 attempts.
pub(super) const ATTEMPTS_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

/// Total deadline for a status-sized request. `poll_miner` runs these in a
/// loop with no deadline of its own, so a slow host must not park it.
const RESPONSE_DEADLINE: Duration = Duration::from_secs(10);

/// Total deadline for a streamed attempts request. Longer because the body
/// is larger and the fetch is user-triggered, not polled. Both deadlines sit
/// under the 30s admission timeout in `http::admission`: a request that
/// outlives admission is dropped before it can return `Unreachable`, which
/// leaves the 60s failure cache below empty and lets a bad host be retried
/// from scratch every time.
const ATTEMPTS_DEADLINE: Duration = Duration::from_secs(25);

pub(super) struct MinerClient {
    client: Client,
    requests: Semaphore,
    peers: Semaphore,
    failures: Mutex<HashMap<String, (Instant, MinerError)>>,
}

impl MinerClient {
    pub(super) fn new() -> Result<Self, MinerError> {
        let client = Client::builder()
            // Catches a stalled connection without bounding a large one: it
            // applies per read and resets after each successful one, so a
            // miner with a long iteration trail is not reported unreachable
            // merely for being verbose. That was the whole-request `timeout`
            // bug. It is NOT a total bound — it re-arms per body frame, so a
            // host trickling one byte under every window would hold the
            // connection open indefinitely. `send` sets the total deadline.
            .read_timeout(Duration::from_secs(4))
            .connect_timeout(Duration::from_secs(3))
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(1)
            .pool_idle_timeout(Duration::from_secs(5))
            .build()
            .map_err(|error| MinerError::Http(error.to_string()))?;
        Ok(Self {
            client,
            requests: Semaphore::new(4),
            peers: Semaphore::new(2),
            failures: Mutex::new(HashMap::new()),
        })
    }

    pub(super) async fn json(
        &self,
        base: &str,
        path: &str,
        query: &[(&str, String)],
        peer: bool,
    ) -> Result<Value, MinerError> {
        self.guarded(base, peer, self.read(base, path, query)).await
    }

    /// Stream `/api/v1/mining/attempts`, folding rows as they arrive.
    pub(super) async fn attempts(
        &self,
        base: &str,
        query: &[(&str, String)],
        peer: bool,
    ) -> Result<AttemptsBody, MinerError> {
        self.guarded(base, peer, self.read_attempts(base, query))
            .await
    }

    /// Run one request under the shared request and peer limits, with the
    /// per-host negative cache for unreachable peers.
    async fn guarded<T>(
        &self,
        base: &str,
        peer: bool,
        request: impl Future<Output = Result<T, MinerError>>,
    ) -> Result<T, MinerError> {
        // Acquire peer capacity first so queued peer work cannot occupy local slots.
        let _peer = if peer {
            Some(
                self.peers
                    .acquire()
                    .await
                    .map_err(|error| MinerError::Http(error.to_string()))?,
            )
        } else {
            None
        };
        let _request = self
            .requests
            .acquire()
            .await
            .map_err(|error| MinerError::Http(error.to_string()))?;
        if peer {
            let mut failures = self.failures.lock().await;
            failures.retain(|_, (expires, _)| *expires > Instant::now());
            if let Some((_, error)) = failures.get(base) {
                return Err(error.clone());
            }
            if failures.len() >= 128 {
                return Err(MinerError::Http(
                    "peer failure cache capacity exhausted".into(),
                ));
            }
        }
        let result = request.await;
        if peer && let Err(error @ MinerError::Unreachable(_)) = &result {
            let mut failures = self.failures.lock().await;
            if failures.len() < 128 {
                let _ = failures.insert(
                    base.to_owned(),
                    (Instant::now() + Duration::from_secs(60), error.clone()),
                );
            }
        }
        result
    }

    /// `deadline` is the total bound the client-wide `read_timeout` cannot
    /// give, and every caller states its own: a byte cap and a time budget
    /// are different properties, so deriving one from the other would hand a
    /// later caller with an intermediate cap a deadline nobody chose.
    async fn send(
        &self,
        base: &str,
        path: &str,
        query: &[(&str, String)],
        cap: usize,
        deadline: Duration,
    ) -> Result<Response, MinerError> {
        let mut url = Url::parse(&format!("{}{path}", base.trim_end_matches('/')))
            .map_err(|error| MinerError::Http(error.to_string()))?;
        if !query.is_empty() {
            let _ = url
                .query_pairs_mut()
                .extend_pairs(query.iter().map(|(key, value)| (*key, value.as_str())));
        }
        let response = self
            .client
            .get(url)
            .header("accept", "application/json")
            .timeout(deadline)
            .send()
            .await
            .map_err(transport)?;
        if !response.status().is_success() {
            return Err(match response.status().as_u16() {
                404 => query
                    .iter()
                    .find(|(key, _)| *key == "solution_number")
                    .and_then(|(_, value)| value.parse().ok())
                    .map_or(MinerError::UpstreamStatus(404), MinerError::NotFound),
                429 => MinerError::RateLimited,
                status => MinerError::UpstreamStatus(status),
            });
        }
        if response
            .content_length()
            .is_some_and(|length| length > cap as u64)
        {
            return Err(MinerError::BodyTooLarge { cap });
        }
        Ok(response)
    }

    async fn read(
        &self,
        base: &str,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<Value, MinerError> {
        let mut response = self
            .send(base, path, query, RESPONSE_BYTES, RESPONSE_DEADLINE)
            .await?;
        let mut bytes = Vec::with_capacity(RESPONSE_BYTES);
        while let Some(chunk) = response.chunk().await.map_err(transport)? {
            if bytes.len().saturating_add(chunk.len()) > RESPONSE_BYTES {
                return Err(MinerError::BodyTooLarge {
                    cap: RESPONSE_BYTES,
                });
            }
            bytes.extend_from_slice(&chunk);
        }
        let value = serde_json::from_slice(&bytes)
            .map_err(|error| MinerError::Unparsable(error.to_string()))?;
        unwrap_envelope(value)
    }

    async fn read_attempts(
        &self,
        base: &str,
        query: &[(&str, String)],
    ) -> Result<AttemptsBody, MinerError> {
        let mut response = self
            .send(
                base,
                "/api/v1/mining/attempts",
                query,
                ATTEMPTS_RESPONSE_BYTES,
                ATTEMPTS_DEADLINE,
            )
            .await?;
        // The decoder runs on a blocking thread and reads chunks from a small
        // channel, so at most a few chunks and one attempt row are in memory.
        let (chunks, receiver) = mpsc::channel(16);
        let decoder =
            tokio::task::spawn_blocking(move || stream::decode(ChannelReader::new(receiver)));
        let mut total = 0_usize;
        let mut failure = None;
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    total = total.saturating_add(chunk.len());
                    if total > ATTEMPTS_RESPONSE_BYTES {
                        failure = Some(MinerError::BodyTooLarge {
                            cap: ATTEMPTS_RESPONSE_BYTES,
                        });
                        break;
                    }
                    // A closed channel means the decoder already failed.
                    if chunks.send(chunk.to_vec()).await.is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    failure = Some(transport(error));
                    break;
                }
            }
        }
        // Closing the channel ends the decoder's input; a transfer failure
        // then wins over the decoder's truncated-input error.
        drop(chunks);
        let decoded = decoder
            .await
            .map_err(|error| MinerError::Http(error.to_string()))?;
        failure.map_or(decoded, Err)
    }
}

/// Blocking reader over body chunks sent from the async request task.
struct ChannelReader {
    receiver: mpsc::Receiver<Vec<u8>>,
    chunk: Vec<u8>,
    offset: usize,
}

impl ChannelReader {
    const fn new(receiver: mpsc::Receiver<Vec<u8>>) -> Self {
        Self {
            receiver,
            chunk: Vec::new(),
            offset: 0,
        }
    }
}

impl Read for ChannelReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        while self.offset >= self.chunk.len() {
            match self.receiver.blocking_recv() {
                Some(chunk) => {
                    self.chunk = chunk;
                    self.offset = 0;
                }
                None => return Ok(0),
            }
        }
        let available = self.chunk.get(self.offset..).unwrap_or_default();
        let n = buf.len().min(available.len());
        if let (Some(target), Some(source)) = (buf.get_mut(..n), available.get(..n)) {
            target.copy_from_slice(source);
        }
        self.offset += n;
        Ok(n)
    }
}

fn transport(error: reqwest::Error) -> MinerError {
    // Keep negative entries bounded and avoid exposing descriptor query strings.
    MinerError::Unreachable(error.without_url().to_string().chars().take(256).collect())
}
