// SPDX-License-Identifier: AGPL-3.0-or-later

//! `/api/health` response.

use serde::{Deserialize, Serialize};

/// Current `/api/health` body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    /// Always `true` on a successful handler response in the current API.
    pub ok: bool,
    /// ISO 8601 last `/api/v1/status` poll.
    pub last_status_fetch_at: Option<String>,
    /// ISO 8601 last block insert.
    pub last_block_insert_at: Option<String>,
    /// ISO 8601 last substrate head event.
    pub last_substrate_event_at: Option<String>,
    /// Live WSS socket state.
    pub chain_connected: bool,
}
