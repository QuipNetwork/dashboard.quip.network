// SPDX-License-Identifier: AGPL-3.0-or-later
//! One bounded HTTP client shared by local polling and peer requests.

use super::parse::{MinerError, unwrap_envelope};
use reqwest::{Client, Url};
use serde_json::Value;
use std::collections::HashMap;
use tokio::{
    sync::{Mutex, Semaphore},
    time::{Duration, Instant},
};

pub(super) const RESPONSE_BYTES: usize = 4 * 1024 * 1024;

pub(super) struct MinerClient {
    client: Client,
    requests: Semaphore,
    peers: Semaphore,
    failures: Mutex<HashMap<String, (Instant, MinerError)>>,
}

impl MinerClient {
    pub(super) fn new() -> Result<Self, MinerError> {
        let client = Client::builder()
            .timeout(Duration::from_secs(4))
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
        let result = self.read(base, path, query).await;
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

    async fn read(
        &self,
        base: &str,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<Value, MinerError> {
        let mut url = Url::parse(&format!("{}{path}", base.trim_end_matches('/')))
            .map_err(|error| MinerError::Http(error.to_string()))?;
        if !query.is_empty() {
            let _ = url
                .query_pairs_mut()
                .extend_pairs(query.iter().map(|(key, value)| (*key, value.as_str())));
        }
        let mut response = self
            .client
            .get(url)
            .header("accept", "application/json")
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
            .is_some_and(|length| length > RESPONSE_BYTES as u64)
        {
            return Err(MinerError::BodyTooLarge {
                cap: RESPONSE_BYTES,
            });
        }
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
}

fn transport(error: reqwest::Error) -> MinerError {
    // Keep negative entries bounded and avoid exposing descriptor query strings.
    MinerError::Unreachable(error.without_url().to_string().chars().take(256).collect())
}
