// SPDX-License-Identifier: AGPL-3.0-or-later

//! Validated 32-byte block hashes as `0x`-prefixed hex.

use std::fmt::{Display, Formatter};
use std::hash::{Hash, Hasher};
use std::str::FromStr;

use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A 32-byte hash encoded as `0x` plus 64 hexadecimal digits.
///
/// The original hex spelling is preserved for JSON round-trips. Equality
/// compares the decoded bytes, so mixed-case hex of the same value is equal.
#[derive(Debug, Clone, Eq)]
pub struct BlockHash {
    bytes: [u8; 32],
    text: String,
}

/// Why a block hash was rejected.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BlockHashError {
    /// The input did not start with `0x`.
    #[error("block hash must start with 0x")]
    MissingPrefix,
    /// The hex body was not exactly 64 digits.
    #[error("block hash hex must be 64 digits, got {actual}")]
    InvalidLength {
        /// Number of hex digits after `0x`.
        actual: usize,
    },
    /// A character was not a hexadecimal digit.
    #[error("block hash contains invalid hex {found:?} at index {index}")]
    InvalidHex {
        /// Byte index in the full input string.
        index: usize,
        /// The rejected byte.
        found: u8,
    },
}

impl BlockHash {
    /// Number of bytes in the hash.
    pub const BYTE_LEN: usize = 32;

    /// Returns the 32 raw bytes.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.bytes
    }

    /// Returns the original `0x`-prefixed hex text.
    #[must_use]
    pub fn as_hex(&self) -> &str {
        &self.text
    }
}

impl PartialEq for BlockHash {
    fn eq(&self, other: &Self) -> bool {
        self.bytes == other.bytes
    }
}

impl Hash for BlockHash {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.bytes.hash(state);
    }
}

impl Display for BlockHash {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.text)
    }
}

impl From<[u8; 32]> for BlockHash {
    fn from(bytes: [u8; 32]) -> Self {
        Self {
            text: encode_hex(&bytes),
            bytes,
        }
    }
}

impl FromStr for BlockHash {
    type Err = BlockHashError;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        let Some(hex) = raw.strip_prefix("0x") else {
            return Err(BlockHashError::MissingPrefix);
        };
        if hex.len() != 64 {
            return Err(BlockHashError::InvalidLength { actual: hex.len() });
        }

        let mut bytes = Vec::with_capacity(32);
        for (pair_index, &pair) in hex.as_bytes().as_chunks::<2>().0.iter().enumerate() {
            let high = hex_nibble(pair[0], 2 + pair_index * 2)?;
            let low = hex_nibble(pair[1], 3 + pair_index * 2)?;
            bytes.push((high << 4) | low);
        }

        let Ok(bytes) = <[u8; 32]>::try_from(bytes) else {
            return Err(BlockHashError::InvalidLength { actual: hex.len() });
        };

        Ok(Self {
            bytes,
            text: raw.to_owned(),
        })
    }
}

fn hex_nibble(byte: u8, index: usize) -> Result<u8, BlockHashError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(BlockHashError::InvalidHex { index, found: byte }),
    }
}

fn hex_digit(nibble: u8) -> u8 {
    let nibble = nibble & 0x0f;
    if nibble < 10 {
        b'0' + nibble
    } else {
        b'a' + (nibble - 10)
    }
}

fn encode_hex(bytes: &[u8; 32]) -> String {
    let mut out = String::with_capacity(66);
    out.push_str("0x");
    for byte in bytes {
        out.push(char::from(hex_digit(byte >> 4)));
        out.push(char::from(hex_digit(byte & 0x0f)));
    }
    out
}

impl Serialize for BlockHash {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.text)
    }
}

impl<'de> Deserialize<'de> for BlockHash {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_str(BlockHashVisitor)
    }
}

struct BlockHashVisitor;

impl Visitor<'_> for BlockHashVisitor {
    type Value = BlockHash;

    fn expecting(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a 0x-prefixed 32-byte hex string")
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        value.parse().map_err(E::custom)
    }
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::panic_in_result_fn,
        reason = "deliberate assertion-based unit tests; assertions are the intent, not a check_eq helper"
    )]

    use super::{BlockHash, BlockHashError};
    use std::error::Error;

    const ZERO: &str = "0x0000000000000000000000000000000000000000000000000000000000000000";
    const MIXED: &str = "0x0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789ABCDEF";

    #[test]
    fn parses_and_round_trips_hex() -> Result<(), Box<dyn Error>> {
        let hash: BlockHash = ZERO.parse()?;
        assert_eq!(hash.as_hex(), ZERO);
        assert_eq!(hash.as_bytes(), &[0u8; 32]);
        assert_eq!(serde_json::to_string(&hash)?, format!("\"{ZERO}\""));
        let parsed: BlockHash = serde_json::from_str(&format!("\"{ZERO}\""))?;
        assert_eq!(parsed, hash);
        Ok(())
    }

    #[test]
    fn preserves_mixed_case_and_compares_bytes() -> Result<(), Box<dyn Error>> {
        let mixed: BlockHash = MIXED.parse()?;
        assert_eq!(mixed.as_hex(), MIXED);
        let lower: BlockHash = MIXED.to_ascii_lowercase().parse()?;
        assert_eq!(mixed, lower);
        assert_eq!(serde_json::to_string(&mixed)?, format!("\"{MIXED}\""));
        Ok(())
    }

    #[test]
    fn rejects_invalid_hashes() {
        assert_eq!("".parse::<BlockHash>(), Err(BlockHashError::MissingPrefix));
        assert_eq!(
            "0000000000000000000000000000000000000000000000000000000000000000".parse::<BlockHash>(),
            Err(BlockHashError::MissingPrefix)
        );
        assert_eq!(
            "0X0000000000000000000000000000000000000000000000000000000000000000"
                .parse::<BlockHash>(),
            Err(BlockHashError::MissingPrefix)
        );
        assert_eq!(
            "0x00".parse::<BlockHash>(),
            Err(BlockHashError::InvalidLength { actual: 2 })
        );
        assert!(format!("{ZERO}0").parse::<BlockHash>().is_err());
        assert!(
            "0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"
                .parse::<BlockHash>()
                .is_err()
        );
        assert!(serde_json::from_str::<BlockHash>("\"0x00\"").is_err());
        assert!(serde_json::from_str::<BlockHash>("1").is_err());
    }

    #[test]
    fn from_bytes_encodes_lowercase() {
        let hash = BlockHash::from([0xab; 32]);
        assert!(hash.as_hex().starts_with("0xab"));
        assert_eq!(hash.as_hex().len(), 66);
    }
}
