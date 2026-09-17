// SPDX-License-Identifier: AGPL-3.0-or-later
//! Stable filesystem paths for qblock and miner data files.
use std::path::PathBuf;

/// Directory holding the fan-out qblock tree and its manifest.
pub const QBLOCKS_DIR: &str = "qblocks";
/// Directory holding per-miner data trees.
pub const MINERS_DIR: &str = "miners";

/// First 8 hex chars of a stable hash of `id`, split 4/4.
fn hash_prefix(id: &str) -> (String, String) {
    let digest = blake3_or_sha256(id);
    let hex_: String = digest.chars().take(8).collect();
    (hex_[..4].to_string(), hex_[4..8].to_string())
}

/// Leaf file name: the id tail plus `.json`.
pub fn qblock_filename(id: &str) -> String {
    format!("{id}.json")
}

/// Relative path `<hhhh>/<llll>/<tail>.json`.
pub fn qblock_rel_path(id: &str) -> PathBuf {
    let (a, b) = hash_prefix(id);
    let tail = id.chars().skip(8).collect::<String>();
    PathBuf::from(a).join(b).join(format!("{tail}.json"))
}

/// Relative path for a miner's directory.
pub fn dashboard_rel_path(account: &str) -> PathBuf {
    PathBuf::from(MINERS_DIR).join(account)
}

// Placeholder — replaced in Task 2 by a concrete hasher.
fn blake3_or_sha256(id: &str) -> String {
    // TODO(Task 2): real hash. For now a stable dummy for test determinism.
    let mut x: u128 = 0;
    for b in id.as_bytes() {
        x = x.wrapping_mul(31).wrapping_add(*b as u128);
    }
    format!("{x:016x}")
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
}
