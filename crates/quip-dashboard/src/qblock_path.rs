// SPDX-License-Identifier: AGPL-3.0-or-later
//! Stable filesystem paths for qblock and miner data files.
use sha2::{Digest, Sha256};
use std::path::PathBuf;

/// Directory holding the fan-out qblock tree and its manifest.
pub const QBLOCKS_DIR: &str = "qblocks";
/// Directory holding per-miner data trees.
pub const MINERS_DIR: &str = "miners";

/// First 8 hex chars of a stable hash of `id`, split 4/4.
fn hash_prefix(id: &str) -> (String, String) {
    let digest = Sha256::digest(id.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    (hex[..4].to_string(), hex[4..8].to_string())
}

/// Leaf file name: the id tail plus `.json`.
pub fn qblock_filename(id: &str) -> String {
    format!("{id}.json")
}

/// Relative path `<hhhh>/<llll>/<tail>.json`.
pub fn qblock_rel_path(id: &str) -> PathBuf {
    let (a, b) = hash_prefix(id);
    // The id tail is the id with its first 8 characters removed; an id
    // shorter than 8 characters keeps its full id as the readable tail.
    let tail = if id.len() < 8 {
        id.to_string()
    } else {
        id.chars().skip(8).collect::<String>()
    };
    PathBuf::from(a).join(b).join(format!("{tail}.json"))
}

/// Relative path for a miner's directory.
pub fn dashboard_rel_path(account: &str) -> PathBuf {
    PathBuf::from(MINERS_DIR).join(account)
}

/// Atomically write `bytes` to `root.join(rel)`: create parent dirs, write to
/// a pid-suffixed temp file, then rename over the target. Never leaves a
/// partial file at `rel`.
///
/// # Errors
/// Returns an I/O error if directory creation, the temp write, or the rename fails.
pub async fn atomic_write(
    root: &std::path::Path,
    rel: &std::path::Path,
    bytes: &[u8],
) -> std::io::Result<()> {
    let abs = root.join(rel);
    if let Some(parent) = abs.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let tmp = abs.with_file_name(format!(
        ".{}.{}.tmp",
        abs.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("file"),
        std::process::id()
    ));
    tokio::fs::write(&tmp, bytes).await?;
    tokio::fs::rename(&tmp, &abs).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fan_out_is_4_hex_per_level() {
        // A 16-hex-char id hashes to 8 hex chars of bucket + 8 rest.
        let rel = qblock_rel_path("0000000000000001");
        let s = rel.to_string_lossy().to_string();
        let parts: Vec<&str> = s.split('/').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].len(), 4);
        assert_eq!(parts[1].len(), 4);
        assert!(parts[0].chars().all(|c| c.is_ascii_hexdigit()));
        assert!(parts[1].chars().all(|c| c.is_ascii_hexdigit()));
        assert!(parts[2].ends_with(".json"));
    }
    #[test]
    fn same_id_same_path() {
        assert_eq!(qblock_rel_path("42"), qblock_rel_path("42"));
    }
    #[test]
    fn short_id_full_tail() {
        // An id shorter than 8 chars: bucket comes from the hash, tail is full id.
        let rel = qblock_rel_path("42");
        let s = rel.to_string_lossy().to_string();
        assert_eq!(s.split('/').count(), 3);
        assert!(s.ends_with("42.json"));
    }
    #[tokio::test]
    async fn atomic_write_replaces_and_creates_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let rel = qblock_rel_path("abc");
        let abs = dir.path().join(&rel);
        atomic_write(dir.path(), &rel, b"one").await.unwrap();
        assert_eq!(tokio::fs::read(&abs).await.unwrap(), b"one");
        // Re-write overwrites atomically.
        atomic_write(dir.path(), &rel, b"two").await.unwrap();
        assert_eq!(tokio::fs::read(&abs).await.unwrap(), b"two");
        // No temp files left behind.
        let mut leftovers = vec![];
        let mut stack = vec![dir.path().to_path_buf()];
        while let Some(d) = stack.pop() {
            let mut rd = tokio::fs::read_dir(&d).await.unwrap();
            while let Some(e) = rd.next_entry().await.unwrap() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.ends_with(".tmp") {
                    leftovers.push(name);
                }
                if e.file_type().await.unwrap().is_dir() {
                    stack.push(e.path());
                }
            }
        }
        assert!(leftovers.is_empty(), "temp files: {leftovers:?}");
    }
}
