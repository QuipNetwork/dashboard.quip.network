// SPDX-License-Identifier: AGPL-3.0-or-later

//! Canonical nonnegative integer decimal strings.

use std::fmt::{Display, Formatter};
use std::str::FromStr;

use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Nonnegative canonical decimal text used for protocol integers.
///
/// Accepted values are `0` or a digit string with no leading zero. Signs,
/// whitespace, an empty string, a fractional part, and any non-digit are
/// rejected. JSON (de)serialization uses a JSON string, never a number.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DecimalString(String);

impl Ord for DecimalString {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0
            .len()
            .cmp(&other.0.len())
            .then_with(|| self.0.cmp(&other.0))
    }
}

impl PartialOrd for DecimalString {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// Why a decimal string was rejected.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DecimalStringError {
    /// The input was empty.
    #[error("decimal string is empty")]
    Empty,
    /// The input started with `+` or `-`.
    #[error("decimal string must not have a sign")]
    Signed,
    /// The input contained ASCII whitespace.
    #[error("decimal string contains whitespace at index {index}")]
    Whitespace {
        /// Byte index of the whitespace.
        index: usize,
    },
    /// The input contained a non-digit character that is not a sign or whitespace.
    #[error("decimal string contains invalid character {found:?} at index {index}")]
    InvalidCharacter {
        /// Byte index of the invalid character.
        index: usize,
        /// The rejected character.
        found: char,
    },
    /// The input had a leading zero and was not the value zero.
    #[error("decimal string has a leading zero")]
    LeadingZero,
}

/// A canonical decimal string that does not fit in `u64`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("decimal string {value} does not fit in u64")]
pub struct DecimalToU64Error {
    /// The decimal that overflowed `u64`.
    pub value: DecimalString,
}

impl DecimalString {
    /// Returns the canonical decimal digits.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Parses the decimal as `u64`.
    ///
    /// # Errors
    ///
    /// Returns [`DecimalToU64Error`] when the value is greater than [`u64::MAX`].
    pub fn to_u64(&self) -> Result<u64, DecimalToU64Error> {
        match self.0.parse::<u64>() {
            Ok(value) => Ok(value),
            Err(_) => Err(DecimalToU64Error {
                value: self.clone(),
            }),
        }
    }
}

impl Display for DecimalString {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl FromStr for DecimalString {
    type Err = DecimalStringError;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        if raw.is_empty() {
            return Err(DecimalStringError::Empty);
        }

        let mut chars = raw.char_indices();
        let Some((first_index, first)) = chars.next() else {
            return Err(DecimalStringError::Empty);
        };

        if first == '+' || first == '-' {
            return Err(DecimalStringError::Signed);
        }
        classify_digit(first_index, first)?;

        for (index, found) in chars {
            classify_digit(index, found)?;
        }

        if first == '0' && raw.len() > 1 {
            return Err(DecimalStringError::LeadingZero);
        }

        Ok(Self(raw.to_owned()))
    }
}

fn classify_digit(index: usize, found: char) -> Result<(), DecimalStringError> {
    if found.is_ascii_whitespace() {
        return Err(DecimalStringError::Whitespace { index });
    }
    if found.is_ascii_digit() {
        return Ok(());
    }
    Err(DecimalStringError::InvalidCharacter { index, found })
}

impl TryFrom<&str> for DecimalString {
    type Error = DecimalStringError;

    fn try_from(raw: &str) -> Result<Self, Self::Error> {
        raw.parse()
    }
}

impl TryFrom<String> for DecimalString {
    type Error = DecimalStringError;

    fn try_from(raw: String) -> Result<Self, Self::Error> {
        raw.parse()
    }
}

impl From<u64> for DecimalString {
    fn from(value: u64) -> Self {
        Self(value.to_string())
    }
}

impl TryFrom<&DecimalString> for u64 {
    type Error = DecimalToU64Error;

    fn try_from(value: &DecimalString) -> Result<Self, Self::Error> {
        value.to_u64()
    }
}

impl Serialize for DecimalString {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for DecimalString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_str(DecimalStringVisitor)
    }
}

struct DecimalStringVisitor;

impl Visitor<'_> for DecimalStringVisitor {
    type Value = DecimalString;

    fn expecting(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a canonical nonnegative decimal string")
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

    use super::{DecimalString, DecimalStringError};
    use std::error::Error;

    const U256_MAX: &str =
        "115792089237316195423570985008687907853269984665640564039457584007913129639935";

    #[test]
    fn preserves_values_above_u128() -> Result<(), Box<dyn Error>> {
        let raw = U256_MAX;
        let value: DecimalString = raw.parse()?;
        assert_eq!(serde_json::to_string(&value)?, format!("\"{raw}\""));
        assert!("01".parse::<DecimalString>().is_err());
        assert!("-1".parse::<DecimalString>().is_err());
        Ok(())
    }

    #[test]
    fn accepts_zero_and_canonical_digits() -> Result<(), Box<dyn Error>> {
        let zero: DecimalString = "0".parse()?;
        assert_eq!(zero.as_str(), "0");
        assert_eq!(zero.to_u64()?, 0);
        assert_eq!(format!("{zero}"), "0");

        let ten: DecimalString = "10".parse()?;
        assert_eq!(ten.as_str(), "10");
        assert_eq!(u64::try_from(&ten)?, 10);
        assert_eq!(DecimalString::from(10u64).as_str(), "10");
        Ok(())
    }

    #[test]
    fn orders_decimals_numerically_without_narrowing() -> Result<(), Box<dyn Error>> {
        let mut values = ["10", "2", U256_MAX, "0", "18446744073709551616"]
            .into_iter()
            .map(str::parse::<DecimalString>)
            .collect::<Result<Vec<_>, _>>()?;
        values.sort();
        assert_eq!(
            values.iter().map(DecimalString::as_str).collect::<Vec<_>>(),
            ["0", "2", "10", "18446744073709551616", U256_MAX]
        );
        Ok(())
    }

    #[test]
    fn rejects_invalid_text() {
        assert_eq!("".parse::<DecimalString>(), Err(DecimalStringError::Empty));
        assert_eq!(
            "+".parse::<DecimalString>(),
            Err(DecimalStringError::Signed)
        );
        assert_eq!(
            "-1".parse::<DecimalString>(),
            Err(DecimalStringError::Signed)
        );
        assert_eq!(
            "01".parse::<DecimalString>(),
            Err(DecimalStringError::LeadingZero)
        );
        assert_eq!(
            "00".parse::<DecimalString>(),
            Err(DecimalStringError::LeadingZero)
        );
        assert_eq!(
            " 1".parse::<DecimalString>(),
            Err(DecimalStringError::Whitespace { index: 0 })
        );
        assert_eq!(
            "1 ".parse::<DecimalString>(),
            Err(DecimalStringError::Whitespace { index: 1 })
        );
        assert_eq!(
            "1.0".parse::<DecimalString>(),
            Err(DecimalStringError::InvalidCharacter {
                index: 1,
                found: '.',
            })
        );
        assert_eq!(
            "1e2".parse::<DecimalString>(),
            Err(DecimalStringError::InvalidCharacter {
                index: 1,
                found: 'e',
            })
        );
    }

    #[test]
    fn u64_conversion_overflows_above_max() -> Result<(), Box<dyn Error>> {
        let max: DecimalString = u64::MAX.to_string().parse()?;
        assert_eq!(max.to_u64()?, u64::MAX);

        let overflow: DecimalString = "18446744073709551616".parse()?;
        assert!(overflow.to_u64().is_err());

        let huge: DecimalString = U256_MAX.parse()?;
        assert!(huge.to_u64().is_err());
        Ok(())
    }

    #[test]
    fn json_round_trip_and_invalid_deserialization() -> Result<(), Box<dyn Error>> {
        let value: DecimalString = U256_MAX.parse()?;
        let json = serde_json::to_string(&value)?;
        assert_eq!(json, format!("\"{U256_MAX}\""));
        let parsed: DecimalString = serde_json::from_str(&json)?;
        assert_eq!(parsed, value);

        assert!(serde_json::from_str::<DecimalString>("1").is_err());
        assert!(serde_json::from_str::<DecimalString>("null").is_err());
        assert!(serde_json::from_str::<DecimalString>("\"\"").is_err());
        assert!(serde_json::from_str::<DecimalString>("\"01\"").is_err());
        assert!(serde_json::from_str::<DecimalString>("\"-1\"").is_err());
        assert!(serde_json::from_str::<DecimalString>("\"+1\"").is_err());
        assert!(serde_json::from_str::<DecimalString>("\" 1\"").is_err());
        assert!(serde_json::from_str::<DecimalString>("\"1 \"").is_err());
        assert!(serde_json::from_str::<DecimalString>("\"1.0\"").is_err());
        Ok(())
    }
}
