// SPDX-License-Identifier: AGPL-3.0-or-later
//! Best-effort per-qblock and per-miner file writer.
use crate::qblock_path::{QBLOCKS_DIR, atomic_write, qblock_rel_path};
use serde_json::Value;

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
}

#[cfg(test)]
mod tests {
    use super::FileWriter;
    use crate::qblock_path::{QBLOCKS_DIR, qblock_rel_path};
    use serde_json::json;

    #[tokio::test]
    async fn qblock_file_lands_in_fan_out() {
        let dir = tempfile::tempdir().unwrap();
        let w = FileWriter::new(dir.path().to_path_buf());
        let payload = json!({"qblockId":"abc","winner":"w"});
        w.write_qblock("abc", &payload).await.unwrap();
        let rel = qblock_rel_path("abc");
        let abs = dir.path().join(QBLOCKS_DIR).join(&rel);
        let bytes = tokio::fs::read(&abs).await.unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["qblockId"], "abc");
    }
}
