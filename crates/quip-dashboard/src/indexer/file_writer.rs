// SPDX-License-Identifier: AGPL-3.0-or-later
//! Best-effort per-qblock and per-miner file writer.
use crate::qblock_path::{MINERS_DIR, QBLOCKS_DIR, atomic_write, qblock_rel_path};
use dashboard_model::QBlockParticipationRecord;
use serde_json::{Value, json};

/// Upper bound on manifest entries, matching the 14-day retention window at
/// the measured ~461 qblocks/day (~6,500 entries). Capping keeps the manifest
/// bounded even if pruning is delayed.
const MAX_MANIFEST_ENTRIES: usize = 10_000;

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

    /// Write a whole miner telemetry document to
    /// `miners/<account>/<name>.json`.
    ///
    /// # Errors
    /// Returns an I/O or serialization error, leaving no partial file.
    async fn write_miner_doc(
        &self,
        account: &str,
        name: &str,
        payload: &Value,
    ) -> std::io::Result<()> {
        let rel = std::path::PathBuf::from("miners")
            .join(account)
            .join(format!("{name}.json"));
        let bytes = serde_json::to_vec(payload).map_err(std::io::Error::other)?;
        atomic_write(&self.root, &rel, &bytes).await
    }

    /// Write one `/api/v1/status` snapshot to `miners/<account>/status.json`.
    ///
    /// # Errors
    /// Returns an I/O or serialization error, leaving no partial file.
    pub async fn write_miner_status(&self, account: &str, payload: &Value) -> std::io::Result<()> {
        self.write_miner_doc(account, "status", payload).await
    }

    /// Write one `/api/v1/stats` snapshot to `miners/<account>/stats.json`.
    ///
    /// # Errors
    /// Returns an I/O or serialization error, leaving no partial file.
    pub async fn write_miner_stats(&self, account: &str, payload: &Value) -> std::io::Result<()> {
        self.write_miner_doc(account, "stats", payload).await
    }

    /// Write the in-flight dispatch probe to
    /// `miners/<account>/current-dispatch.json`.
    ///
    /// # Errors
    /// Returns an I/O or serialization error, leaving no partial file.
    pub async fn write_miner_current_dispatch(
        &self,
        account: &str,
        payload: &Value,
    ) -> std::io::Result<()> {
        self.write_miner_doc(account, "current-dispatch", payload)
            .await
    }

    /// Symlink the miner's own attempt tree at `source` into this writer's
    /// `miners/<account>/mining-attempts` so co-located polls need no network
    /// re-pinning. Creates the link only when the target does not yet exist;
    /// a pre-existing target (a real link or dir) is left untouched.
    ///
    /// # Errors
    /// Returns an I/O error when the link cannot be read or created.
    pub async fn symlink_miner_attempts(
        &self,
        account: &str,
        source: &std::path::Path,
    ) -> std::io::Result<()> {
        let target = self
            .root
            .join(MINERS_DIR)
            .join(account)
            .join("mining-attempts");
        match tokio::fs::symlink_metadata(&target).await {
            Ok(_) => Ok(()), // already linked or otherwise present
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if let Some(parent) = target.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                let source_abs = if source.is_absolute() {
                    source.to_path_buf()
                } else {
                    std::env::current_dir()?.join(source)
                };
                tokio::fs::symlink(source_abs, &target).await
            }
            Err(error) => Err(error),
        }
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
        let mut written: Vec<String> = Vec::new();
        for id in ids {
            let id_participation: Vec<&QBlockParticipationRecord> = participation
                .iter()
                .filter(|p| p.qblock_id.as_str() == id)
                .collect();
            let id_winner = winner.filter(|w| w.qblock_id.as_str() == id);
            let rel = std::path::PathBuf::from(QBLOCKS_DIR)
                .join(qblock_rel_path(id.as_str()))
                .to_string_lossy()
                .into_owned();
            results.push(
                self.write_qblock_merged(&id, id_winner, &id_participation)
                    .await,
            );
            if !written.iter().any(|existing| existing == &rel) {
                written.push(rel);
            }
        }
        let all_ok = results.iter().all(Result::is_ok);
        if all_ok && !written.is_empty() {
            // Keep the manifest fresh as qblocks land so the client can
            // discover them without waiting for the hourly prune tick.
            if let Err(error) = self.add_to_manifest(&written).await {
                tracing::warn!(%error, "qblock manifest update failed");
            }
        }
        results
    }

    /// Prepend `rel_paths` (relative qblock paths, most recent first) to the
    /// manifest, deduplicate against the existing entries, cap to the
    /// retention window, and atomically rewrite `metadata.json`. Missing or
    /// malformed manifests are treated as empty so a fresh deployment still
    /// produces a valid manifest on the first write.
    ///
    /// # Errors
    /// Returns an I/O error on a manifest read or atomic write.
    async fn add_to_manifest(&self, rel_paths: &[String]) -> std::io::Result<()> {
        let rel = std::path::PathBuf::from(QBLOCKS_DIR).join("metadata.json");
        let abs = self.root.join(&rel);
        let mut current: Vec<String> = if abs.exists() {
            tokio::fs::read(&abs).await.ok().and_then(|bytes| {
                serde_json::from_slice::<Value>(&bytes)
                    .ok()
                    .and_then(|v| v.get("qblocks").and_then(Value::as_array).cloned())
                    .and_then(|arr| {
                        arr.into_iter()
                            .filter_map(|v| v.as_str().map(str::to_owned))
                            .collect::<Vec<String>>()
                            .into()
                    })
            })
        } else {
            None
        }
        .unwrap_or_default();
        for path in rel_paths {
            if !current.iter().any(|existing| existing == path) {
                current.insert(0, path.clone());
            }
        }
        current.truncate(MAX_MANIFEST_ENTRIES);
        self.update_manifest(&current).await
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
        let obj = existing
            .as_object_mut()
            .ok_or_else(|| std::io::Error::other("qblock payload is not an object"))?;
        let _ = obj.insert("qblockId".to_owned(), json!(id));
        if let Some(w) = winner {
            let _ = obj.insert(
                "winner".to_owned(),
                serde_json::to_value(w).map_err(std::io::Error::other)?,
            );
        } else if !obj.contains_key("winner") {
            let _ = obj.insert("winner".to_owned(), Value::Null);
        }
        let _ = obj.insert("participation".to_owned(), Value::Array(merged));
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

    /// Walk `data/qblocks` and delete qblock files older than the cutoff,
    /// then rebuild `metadata.json` with the surviving files (most recent
    /// first by modified time). `metadata.json` itself is skipped.
    ///
    /// # Errors
    /// Returns an I/O error on a failed walk or manifest write.
    pub async fn prune(&self, since_unix: i64) -> std::io::Result<()> {
        let qblocks_root = self.root.join(QBLOCKS_DIR);
        if !qblocks_root.exists() {
            // A fresh deployment has no qblocks yet; emit an empty manifest
            // rather than failing the maintenance tick.
            return self.update_manifest(&[]).await;
        }
        let mut survivors: Vec<(i64, String)> = Vec::new();
        let mut stack = vec![qblocks_root.clone()];
        while let Some(dir) = stack.pop() {
            let mut rd = tokio::fs::read_dir(&dir).await?;
            while let Some(entry) = rd.next_entry().await? {
                let path = entry.path();
                let meta = entry.metadata().await?;
                if meta.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "json")
                    && path.file_name().and_then(|n| n.to_str()) != Some("metadata.json")
                {
                    let modified = meta.modified()?.duration_since(std::time::UNIX_EPOCH);
                    if let Ok(duration) = modified {
                        let mtime =
                            i64::try_from(duration.as_secs()).map_err(std::io::Error::other)?;
                        if mtime < since_unix {
                            tokio::fs::remove_file(&path).await?;
                        } else {
                            let rel = path
                                .strip_prefix(&self.root)
                                .map_err(std::io::Error::other)?
                                .to_string_lossy()
                                .into_owned();
                            survivors.push((mtime, rel));
                        }
                    }
                }
            }
        }
        survivors.sort_by_key(|(mtime, _)| std::cmp::Reverse(*mtime));
        let listed: Vec<String> = survivors.into_iter().map(|(_, path)| path).collect();
        self.update_manifest(&listed).await
    }

    /// Enforce the retention window: write the manifest from `listed` (most
    /// recent first), then delete any qblock file whose relative path is not
    /// in `listed`.
    ///
    /// # Errors
    /// Returns an I/O error on a manifest write or walk.
    pub async fn write_back(&self, listed: &[String]) -> std::io::Result<()> {
        self.update_manifest(listed).await?;
        let qblocks_root = self.root.join(QBLOCKS_DIR);
        let mut stack = vec![qblocks_root.clone()];
        while let Some(dir) = stack.pop() {
            let mut rd = tokio::fs::read_dir(&dir).await?;
            while let Some(entry) = rd.next_entry().await? {
                let path = entry.path();
                let meta = entry.metadata().await?;
                if meta.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "json")
                    && path.file_name().and_then(|n| n.to_str()) != Some("metadata.json")
                {
                    let rel = path
                        .strip_prefix(&self.root)
                        .map_err(std::io::Error::other)?
                        .to_string_lossy()
                        .into_owned();
                    if !listed.iter().any(|entry| entry == &rel) {
                        tokio::fs::remove_file(&path).await?;
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::panic_in_result_fn,
        reason = "test assertions report file writer correctness while propagating IO errors"
    )]
    #![expect(
        clippy::indexing_slicing,
        reason = "serde JSON fixture indexing returns null for absent object keys"
    )]
    use super::{FileWriter, MINERS_DIR, QBLOCKS_DIR, qblock_rel_path};
    use dashboard_model::QBlockParticipationRecord;
    use serde_json::{Value, json};
    use std::str::FromStr;

    #[tokio::test]
    async fn qblock_file_lands_in_fan_out() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let w = FileWriter::new(dir.path().to_path_buf());
        let payload = json!({"qblockId":"abc","winner":"w"});
        w.write_qblock("abc", &payload).await?;
        let rel = qblock_rel_path("abc");
        let abs = dir.path().join(QBLOCKS_DIR).join(&rel);
        let bytes = tokio::fs::read(&abs).await?;
        let parsed: Value = serde_json::from_slice(&bytes)?;
        assert_eq!(parsed["qblockId"], "abc");
        Ok(())
    }

    #[tokio::test]
    async fn write_batch_merges_winner_and_participation() -> Result<(), Box<dyn std::error::Error>>
    {
        let dir = tempfile::tempdir()?;
        let w = FileWriter::new(dir.path().to_path_buf());
        let winner = dashboard_model::BlockRecord {
            block_hash: dashboard_model::BlockHash::from([1; 32]),
            substrate_block_number: dashboard_model::DecimalString::from_str("100")?,
            substrate_block_hash: dashboard_model::BlockHash::from([2; 32]),
            substrate_parent_hash: dashboard_model::BlockHash::from([3; 32]),
            timestamp: 1_700_000_000,
            miner_id: "5GPP".into(),
            energy: -100.0,
            diversity: 0.5,
            num_valid_solutions: 1,
            mining_time: 60.0,
            device_access_time_us: None,
            reward: dashboard_model::DecimalString::from_str("1000")?,
            qblock_id: dashboard_model::DecimalString::from_str("42")?,
            nonce: dashboard_model::DecimalString::from_str("7")?,
            num_nodes: 1,
            num_edges: 1,
            difficulty_energy: -110.0,
            min_diversity: 0.1,
            min_solutions: 1,
            finalized: true,
            topology_hash: None,
        };
        let part = QBlockParticipationRecord {
            qblock_id: dashboard_model::DecimalString::from_str("42")?,
            account: "5GAA".into(),
            kind: "Cpu".into(),
            budget_seconds: Some(60.0),
            block_number: dashboard_model::DecimalString::from_str("99")?,
        };
        w.write_batch(Some(&winner), &[part])
            .await
            .into_iter()
            .collect::<std::io::Result<()>>()?;
        let rel = qblock_rel_path("42");
        let abs = dir.path().join(QBLOCKS_DIR).join(&rel);
        let bytes = tokio::fs::read(&abs).await?;
        let parsed: Value = serde_json::from_slice(&bytes)?;
        assert_eq!(parsed["qblockId"], "42");
        assert_eq!(parsed["winner"]["minerId"], "5GPP");
        assert_eq!(parsed["participation"][0]["account"], "5GAA");
        Ok(())
    }

    #[tokio::test]
    async fn write_batch_preserves_prior_winner_across_commits()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let w = FileWriter::new(dir.path().to_path_buf());
        let winner = dashboard_model::BlockRecord {
            block_hash: dashboard_model::BlockHash::from([1; 32]),
            substrate_block_number: dashboard_model::DecimalString::from_str("100")?,
            substrate_block_hash: dashboard_model::BlockHash::from([2; 32]),
            substrate_parent_hash: dashboard_model::BlockHash::from([3; 32]),
            timestamp: 1_700_000_000,
            miner_id: "5GPP".into(),
            energy: -100.0,
            diversity: 0.5,
            num_valid_solutions: 1,
            mining_time: 60.0,
            device_access_time_us: None,
            reward: dashboard_model::DecimalString::from_str("1000")?,
            qblock_id: dashboard_model::DecimalString::from_str("42")?,
            nonce: dashboard_model::DecimalString::from_str("7")?,
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
            qblock_id: dashboard_model::DecimalString::from_str("42")?,
            account: "5GAA".into(),
            kind: "Cpu".into(),
            budget_seconds: None,
            block_number: dashboard_model::DecimalString::from_str("99")?,
        };
        w.write_batch(None, &[part_a])
            .await
            .into_iter()
            .collect::<std::io::Result<()>>()?;
        // Second commit: winner lands, a new participant joins.
        let part_b = QBlockParticipationRecord {
            qblock_id: dashboard_model::DecimalString::from_str("42")?,
            account: "5GBB".into(),
            kind: "Gpu".into(),
            budget_seconds: None,
            block_number: dashboard_model::DecimalString::from_str("101")?,
        };
        w.write_batch(Some(&winner), &[part_b])
            .await
            .into_iter()
            .collect::<std::io::Result<()>>()?;
        let rel = qblock_rel_path("42");
        let abs = dir.path().join(QBLOCKS_DIR).join(&rel);
        let bytes = tokio::fs::read(&abs).await?;
        let parsed: Value = serde_json::from_slice(&bytes)?;
        assert_eq!(parsed["winner"]["minerId"], "5GPP");
        let participants = parsed["participation"].as_array().ok_or("no array")?;
        assert_eq!(participants.len(), 2);
        Ok(())
    }

    #[tokio::test]
    async fn write_miner_attempt_keys_on_qblock_fan_out() -> Result<(), Box<dyn std::error::Error>>
    {
        let dir = tempfile::tempdir()?;
        let w = FileWriter::new(dir.path().to_path_buf());
        w.write_miner_attempt("5GPP", "42", &json!({"solutionNumber": 42}))
            .await?;
        let rel = std::path::PathBuf::from("miners")
            .join("5GPP")
            .join("mining-attempts")
            .join(qblock_rel_path("42"));
        let abs = dir.path().join(&rel);
        let bytes = tokio::fs::read(&abs).await?;
        let parsed: Value = serde_json::from_slice(&bytes)?;
        assert_eq!(parsed["solutionNumber"], 42);
        Ok(())
    }

    #[tokio::test]
    async fn write_miner_status_lands_in_miner_tree() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let w = FileWriter::new(dir.path().to_path_buf());
        w.write_miner_status("5GPP", &json!({ "ss58Address": "5GPP" }))
            .await?;
        let abs = dir.path().join("miners/5GPP/status.json");
        let parsed: Value = serde_json::from_slice(&tokio::fs::read(&abs).await?)?;
        assert_eq!(parsed["ss58Address"], "5GPP");
        Ok(())
    }

    #[tokio::test]
    async fn write_miner_stats_lands_in_miner_tree() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let w = FileWriter::new(dir.path().to_path_buf());
        w.write_miner_stats("5GPP", &json!({ "proofsSubmitted": 12 }))
            .await?;
        let abs = dir.path().join("miners/5GPP/stats.json");
        let parsed: Value = serde_json::from_slice(&tokio::fs::read(&abs).await?)?;
        assert_eq!(parsed["proofsSubmitted"], 12);
        Ok(())
    }

    #[tokio::test]
    async fn write_miner_current_dispatch_lands_in_miner_tree()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let w = FileWriter::new(dir.path().to_path_buf());
        w.write_miner_current_dispatch("5GPP", &json!({ "solutionNumber": 9 }))
            .await?;
        let abs = dir.path().join("miners/5GPP/current-dispatch.json");
        let parsed: Value = serde_json::from_slice(&tokio::fs::read(&abs).await?)?;
        assert_eq!(parsed["solutionNumber"], 9);
        Ok(())
    }

    #[tokio::test]
    async fn symlink_miner_attempts_links_source_once() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let w = FileWriter::new(dir.path().to_path_buf());
        // A co-located miner owns `data/attempts` with a leaf file.
        let source = dir.path().join("data/attempts");
        tokio::fs::create_dir_all(&source).await?;
        tokio::fs::write(source.join("attempts.json"), b"{}").await?;
        w.symlink_miner_attempts("5GPP", &source).await?;
        let link = dir
            .path()
            .join(MINERS_DIR)
            .join("5GPP")
            .join("mining-attempts");
        let meta = tokio::fs::symlink_metadata(&link).await?;
        assert!(meta.file_type().is_symlink(), "expected a symlink");
        // The linked tree exposes the miner's own file.
        let via_link = tokio::fs::read(link.join("attempts.json")).await?;
        assert_eq!(via_link, b"{}");
        // A second call is idempotent: the existing link is left untouched.
        w.symlink_miner_attempts("5GPP", &source).await?;
        let text = tokio::fs::read_link(&link).await?;
        assert_eq!(text, source);
        Ok(())
    }

    #[tokio::test]
    async fn manifest_is_atomic_json() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let w = FileWriter::new(dir.path().to_path_buf());
        w.update_manifest(&["qblocks/ab/cd/ef.json".to_string()])
            .await?;
        let abs = dir.path().join("qblocks/metadata.json");
        let parsed: Value = serde_json::from_slice(&tokio::fs::read(&abs).await?)?;
        assert!(parsed["qblocks"].is_array());
        Ok(())
    }

    fn old_mtime(path: &std::path::Path, days_ago: u64) -> std::io::Result<()> {
        let file = std::fs::OpenOptions::new().write(true).open(path)?;
        let now = std::time::SystemTime::now();
        let old = now - std::time::Duration::from_secs(days_ago * 86_400);
        let times = std::fs::FileTimes::new().set_modified(old);
        file.set_times(times)
    }

    #[tokio::test]
    async fn prune_removes_old_files_keeps_manifest() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let w = FileWriter::new(dir.path().to_path_buf());
        w.write_qblock("old", &json!({})).await?;
        w.write_qblock("new", &json!({})).await?;
        let old_rel = std::path::PathBuf::from(QBLOCKS_DIR).join(qblock_rel_path("old"));
        let old_abs = dir.path().join(&old_rel);
        old_mtime(&old_abs, 30)?;
        let now = chrono::Utc::now().timestamp();
        w.prune(now).await?;
        assert!(!old_abs.exists(), "old qblock should be pruned");
        let new_rel = std::path::PathBuf::from(QBLOCKS_DIR).join(qblock_rel_path("new"));
        let new_abs = dir.path().join(&new_rel);
        assert!(new_abs.exists(), "new qblock should survive");
        let manifest_abs = dir.path().join("qblocks/metadata.json");
        let parsed: Value = serde_json::from_slice(&tokio::fs::read(&manifest_abs).await?)?;
        let listed = parsed["qblocks"].as_array().ok_or("no array")?;
        assert!(
            listed
                .iter()
                .any(|p| p == &Value::from(new_rel.to_string_lossy().into_owned()))
        );
        assert!(
            !listed
                .iter()
                .any(|p| p == &Value::from(old_rel.to_string_lossy().into_owned()))
        );
        Ok(())
    }

    #[tokio::test]
    async fn prune_with_missing_qblocks_root_writes_empty_manifest()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let w = FileWriter::new(dir.path().to_path_buf());
        let now = chrono::Utc::now().timestamp();
        w.prune(now).await?;
        let manifest_abs = dir.path().join(QBLOCKS_DIR).join("metadata.json");
        let parsed: Value = serde_json::from_slice(&tokio::fs::read(&manifest_abs).await?)?;
        assert_eq!(parsed["qblocks"].as_array().map(Vec::len), Some(0));
        Ok(())
    }

    #[tokio::test]
    async fn write_batch_lands_written_paths_in_manifest() -> Result<(), Box<dyn std::error::Error>>
    {
        let dir = tempfile::tempdir()?;
        let w = FileWriter::new(dir.path().to_path_buf());
        let winner = dashboard_model::BlockRecord {
            block_hash: dashboard_model::BlockHash::from([1; 32]),
            substrate_block_number: dashboard_model::DecimalString::from_str("100")?,
            substrate_block_hash: dashboard_model::BlockHash::from([2; 32]),
            substrate_parent_hash: dashboard_model::BlockHash::from([3; 32]),
            timestamp: 1_700_000_000,
            miner_id: "5GPP".into(),
            energy: -100.0,
            diversity: 0.5,
            num_valid_solutions: 1,
            mining_time: 60.0,
            device_access_time_us: None,
            reward: dashboard_model::DecimalString::from_str("1000")?,
            qblock_id: dashboard_model::DecimalString::from_str("42")?,
            nonce: dashboard_model::DecimalString::from_str("7")?,
            num_nodes: 1,
            num_edges: 1,
            difficulty_energy: -110.0,
            min_diversity: 0.1,
            min_solutions: 1,
            finalized: true,
            topology_hash: None,
        };
        let results = w.write_batch(Some(&winner), &[]).await;
        assert!(
            results.iter().all(Result::is_ok),
            "write_batch should succeed"
        );
        let manifest_abs = dir.path().join(QBLOCKS_DIR).join("metadata.json");
        let parsed: Value = serde_json::from_slice(&tokio::fs::read(&manifest_abs).await?)?;
        let listed = parsed["qblocks"].as_array().ok_or("no array")?;
        let expected = std::path::PathBuf::from(QBLOCKS_DIR)
            .join(qblock_rel_path("42"))
            .to_string_lossy()
            .into_owned();
        assert!(
            listed.iter().any(|p| p.as_str() == Some(expected.as_str())),
            "manifest should list the just-written qblock path"
        );
        Ok(())
    }

    #[tokio::test]
    async fn write_back_removes_files_outside_window() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let w = FileWriter::new(dir.path().to_path_buf());
        w.write_qblock("keep", &json!({})).await?;
        w.write_qblock("drop", &json!({})).await?;
        let keep_rel = std::path::PathBuf::from(QBLOCKS_DIR).join(qblock_rel_path("keep"));
        let keep_str = keep_rel.to_string_lossy().into_owned();
        w.write_back(std::slice::from_ref(&keep_str)).await?;
        let keep_abs = dir.path().join(&keep_rel);
        let drop_abs = dir.path().join(QBLOCKS_DIR).join(qblock_rel_path("drop"));
        assert!(keep_abs.exists());
        assert!(!drop_abs.exists(), "file outside window should be removed");
        let manifest_abs = dir.path().join("qblocks/metadata.json");
        let parsed: Value = serde_json::from_slice(&tokio::fs::read(&manifest_abs).await?)?;
        let listed = parsed["qblocks"].as_array().ok_or("no array")?;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], Value::from(keep_str));
        Ok(())
    }
}
