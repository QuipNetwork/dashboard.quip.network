// SPDX-License-Identifier: AGPL-3.0-or-later
//! Best-effort per-qblock and per-miner file writer.
use crate::qblock_path::{QBLOCKS_DIR, atomic_write, qblock_rel_path};
use dashboard_model::QBlockParticipationRecord;
use serde_json::{Value, json};

/// Root directory holding `qblocks/` and `miners/` data trees.
#[derive(Clone, Debug)]
pub struct FileWriter {
    /// Filesystem root for all data files.
    pub root: std::path::PathBuf,
}

impl FileWriter {
    /// Create a writer rooted at `root`.
    #[must_use]
    pub fn new(root: std::path::PathBuf) -> Self {
        Self { root }
    }

    /// Write one qblock payload to `qblocks/<4>/<4>/<tail>.json`.
    ///
    /// # Errors
    /// Returns an I/O or serialization error, leaving no partial file.
    pub async fn write_qblock(&self, id: &str, payload: &Value) -> std::io::Result<()> {
        let rel = std::path::PathBuf::from(QBLOCKS_DIR).join(qblock_rel_path(id));
        let bytes = serde_json::to_vec(payload).map_err(std::io::Error::other)?;
        atomic_write(&self.root, &rel, &bytes).await
    }

    /// Write one miner submission payload for a qblock to
    /// `miners/<account>/mining-attempts/<4>/<4>/<tail>.json`.
    ///
    /// # Errors
    /// Returns an I/O or serialization error, leaving no partial file.
    pub async fn write_miner_attempt(
        &self,
        account: &str,
        id: &str,
        payload: &Value,
    ) -> std::io::Result<()> {
        let rel = std::path::PathBuf::from("miners")
            .join(account)
            .join("mining-attempts")
            .join(qblock_rel_path(id));
        let bytes = serde_json::to_vec(payload).map_err(std::io::Error::other)?;
        atomic_write(&self.root, &rel, &bytes).await
    }

    /// Merge one batch of committed records into the per-qblock file tree.
    ///
    /// Each distinct qblock id in the batch (the winner's id plus every
    /// participant's id) gets one merged `data/qblocks/<4>/<4>/<tail>.json`
    /// file holding `{ qblockId, winner, participation }`. The winner block
    /// rides inside the qblock file — it is never a separate tree. Because a
    /// qblock's winner and its participants are committed at different points
    /// in the indexer, each write is merge-aware: an existing file is read,
    /// the new winner (if any) replaces the old, and the new participant rows
    /// are appended with de-duplication by account. Writes stay atomic.
    ///
    /// Returns one result per distinct qblock id; callers treat failures as
    /// best-effort and do not fail the store commit.
    pub async fn write_batch(
        &self,
        winner: Option<&dashboard_model::BlockRecord>,
        participation: &[QBlockParticipationRecord],
    ) -> Vec<std::io::Result<()>> {
        let mut ids: Vec<String> = Vec::new();
        if let Some(w) = winner {
            ids.push(w.qblock_id.as_str().to_owned());
        }
        for p in participation {
            let id = p.qblock_id.as_str();
            if !ids.iter().any(|existing| existing == id) {
                ids.push(id.to_owned());
            }
        }
        let mut results = Vec::new();
        for id in ids {
            let id_participation: Vec<&QBlockParticipationRecord> = participation
                .iter()
                .filter(|p| p.qblock_id.as_str() == id)
                .collect();
            let id_winner = winner.filter(|w| w.qblock_id.as_str() == id);
            results
                .push(self.write_qblock_merged(&id, id_winner, &id_participation).await);
        }
        results
    }

    /// Merge a winner and participation rows into one qblock file, preserving
    /// any winner/participants already present from an earlier commit.
    ///
    /// # Errors
    /// Returns an I/O or serialization error, leaving no partial file.
    async fn write_qblock_merged(
        &self,
        id: &str,
        winner: Option<&dashboard_model::BlockRecord>,
        participation: &[&QBlockParticipationRecord],
    ) -> std::io::Result<()> {
        let rel = std::path::PathBuf::from(QBLOCKS_DIR).join(qblock_rel_path(id));
        let abs = self.root.join(&rel);
        let mut existing = if abs.exists() {
            let bytes = tokio::fs::read(&abs).await?;
            serde_json::from_slice::<Value>(&bytes)
                .map_err(std::io::Error::other)
                .unwrap_or_else(|_| json!({}))
        } else {
            json!({})
        };
        existing["qblockId"] = json!(id);
        if let Some(w) = winner {
            existing["winner"] = serde_json::to_value(w).map_err(std::io::Error::other)?;
        } else if existing.get("winner").is_none() {
            existing["winner"] = Value::Null;
        }
        let merged: Vec<Value> = {
            let mut rows: Vec<Value> = existing
                .get("participation")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut seen: Vec<String> = rows
                .iter()
                .filter_map(|r| r.get("account").and_then(Value::as_str))
                .map(str::to_owned)
                .collect();
            for p in participation {
                let account = p.account.clone();
                if !seen.contains(&account) {
                    rows.push(serde_json::to_value(p).map_err(std::io::Error::other)?);
                    seen.push(account);
                }
            }
            rows
        };
        existing["participation"] = Value::Array(merged);
        let bytes = serde_json::to_vec(&existing).map_err(std::io::Error::other)?;
        atomic_write(&self.root, &rel, &bytes).await
    }

    /// Atomically write the manifest `qblocks/metadata.json` as
    /// `{ "qblocks": [path, ...] }`.
    ///
    /// # Errors
    /// Returns an I/O or serialization error, leaving no partial file.
    pub async fn update_manifest(&self, entries: &[String]) -> std::io::Result<()> {
        let rel = std::path::PathBuf::from(QBLOCKS_DIR).join("metadata.json");
        let payload = json!({ "qblocks": entries });
        let bytes = serde_json::to_vec(&payload).map_err(std::io::Error::other)?;
        atomic_write(&self.root, &rel, &bytes).await
    }
}

#[cfg(test)]
mod tests {
    use super::{FileWriter, QBLOCKS_DIR, qblock_rel_path};
    use dashboard_model::QBlockParticipationRecord;
    use serde_json::{Value, json};
    use std::str::FromStr;

    #[tokio::test]
    async fn qblock_file_lands_in_fan_out() {
        let dir = tempfile::tempdir().unwrap();
        let w = FileWriter::new(dir.path().to_path_buf());
        let payload = json!({"qblockId":"abc","winner":"w"});
        w.write_qblock("abc", &payload).await.unwrap();
        let rel = qblock_rel_path("abc");
        let abs = dir.path().join(QBLOCKS_DIR).join(&rel);
        let bytes = tokio::fs::read(&abs).await.unwrap();
        let parsed: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["qblockId"], "abc");
    }

    #[tokio::test]
    async fn write_batch_merges_winner_and_participation() {
        let dir = tempfile::tempdir().unwrap();
        let w = FileWriter::new(dir.path().to_path_buf());
        let winner = dashboard_model::BlockRecord {
            block_hash: dashboard_model::BlockHash::from([1; 32]),
            substrate_block_number: dashboard_model::DecimalString::from_str("100").unwrap(),
            substrate_block_hash: dashboard_model::BlockHash::from([2; 32]),
            substrate_parent_hash: dashboard_model::BlockHash::from([3; 32]),
            timestamp: 1_700_000_000,
            miner_id: "5GPP".into(),
            energy: -100.0,
            diversity: 0.5,
            num_valid_solutions: 1,
            mining_time: 60.0,
            device_access_time_us: None,
            reward: dashboard_model::DecimalString::from_str("1000").unwrap(),
            qblock_id: dashboard_model::DecimalString::from_str("42").unwrap(),
            nonce: dashboard_model::DecimalString::from_str("7").unwrap(),
            num_nodes: 1,
            num_edges: 1,
            difficulty_energy: -110.0,
            min_diversity: 0.1,
            min_solutions: 1,
            finalized: true,
            topology_hash: None,
        };
        let part = QBlockParticipationRecord {
            qblock_id: dashboard_model::DecimalString::from_str("42").unwrap(),
            account: "5GAA".into(),
            kind: "Cpu".into(),
            budget_seconds: Some(60.0),
            block_number: dashboard_model::DecimalString::from_str("99").unwrap(),
        };
        w.write_batch(Some(&winner), &[part])
            .await
            .into_iter()
            .collect::<std::io::Result<()>>()
            .unwrap();
        let rel = qblock_rel_path("42");
        let abs = dir.path().join(QBLOCKS_DIR).join(&rel);
        let bytes = tokio::fs::read(&abs).await.unwrap();
        let parsed: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["qblockId"], "42");
        assert_eq!(parsed["winner"]["minerId"], "5GPP");
        assert_eq!(parsed["participation"][0]["account"], "5GAA");
    }

    #[tokio::test]
    async fn write_batch_preserves_prior_winner_across_commits() {
        let dir = tempfile::tempdir().unwrap();
        let w = FileWriter::new(dir.path().to_path_buf());
        let winner = dashboard_model::BlockRecord {
            block_hash: dashboard_model::BlockHash::from([1; 32]),
            substrate_block_number: dashboard_model::DecimalString::from_str("100").unwrap(),
            substrate_block_hash: dashboard_model::BlockHash::from([2; 32]),
            substrate_parent_hash: dashboard_model::BlockHash::from([3; 32]),
            timestamp: 1_700_000_000,
            miner_id: "5GPP".into(),
            energy: -100.0,
            diversity: 0.5,
            num_valid_solutions: 1,
            mining_time: 60.0,
            device_access_time_us: None,
            reward: dashboard_model::DecimalString::from_str("1000").unwrap(),
            qblock_id: dashboard_model::DecimalString::from_str("42").unwrap(),
            nonce: dashboard_model::DecimalString::from_str("7").unwrap(),
            num_nodes: 1,
            num_edges: 1,
            difficulty_energy: -110.0,
            min_diversity: 0.1,
            min_solutions: 1,
            finalized: true,
            topology_hash: None,
        };
        // First commit: only participation, winner not yet known.
        let part_a = QBlockParticipationRecord {
            qblock_id: dashboard_model::DecimalString::from_str("42").unwrap(),
            account: "5GAA".into(),
            kind: "Cpu".into(),
            budget_seconds: None,
            block_number: dashboard_model::DecimalString::from_str("99").unwrap(),
        };
        w.write_batch(None, &[part_a])
            .await
            .into_iter()
            .collect::<std::io::Result<()>>()
            .unwrap();
        // Second commit: winner lands, a new participant joins.
        let part_b = QBlockParticipationRecord {
            qblock_id: dashboard_model::DecimalString::from_str("42").unwrap(),
            account: "5GBB".into(),
            kind: "Gpu".into(),
            budget_seconds: None,
            block_number: dashboard_model::DecimalString::from_str("101").unwrap(),
        };
        w.write_batch(Some(&winner), &[part_b])
            .await
            .into_iter()
            .collect::<std::io::Result<()>>()
            .unwrap();
        let rel = qblock_rel_path("42");
        let abs = dir.path().join(QBLOCKS_DIR).join(&rel);
        let bytes = tokio::fs::read(&abs).await.unwrap();
        let parsed: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["winner"]["minerId"], "5GPP");
        let participants = parsed["participation"].as_array().unwrap();
        assert_eq!(participants.len(), 2);
    }

    #[tokio::test]
    async fn write_miner_attempt_keys_on_qblock_fan_out() {
        let dir = tempfile::tempdir().unwrap();
        let w = FileWriter::new(dir.path().to_path_buf());
        w.write_miner_attempt("5GPP", "42", &json!({"solutionNumber": 42}))
            .await
            .unwrap();
        let rel = std::path::PathBuf::from("miners")
            .join("5GPP")
            .join("mining-attempts")
            .join(qblock_rel_path("42"));
        let abs = dir.path().join(&rel);
        let bytes = tokio::fs::read(&abs).await.unwrap();
        let parsed: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["solutionNumber"], 42);
    }

    #[tokio::test]
    async fn manifest_is_atomic_json() {
        let dir = tempfile::tempdir().unwrap();
        let w = FileWriter::new(dir.path().to_path_buf());
        w.update_manifest(&["qblocks/ab/cd/ef.json".to_string()])
            .await
            .unwrap();
        let abs = dir.path().join("qblocks/metadata.json");
        let parsed: Value = serde_json::from_slice(&tokio::fs::read(&abs).await.unwrap()).unwrap();
        assert!(parsed["qblocks"].is_array());
    }
}
