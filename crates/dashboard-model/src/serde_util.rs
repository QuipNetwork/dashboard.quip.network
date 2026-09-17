// SPDX-License-Identifier: AGPL-3.0-or-later

//! Serde helpers for TypeScript optional-nullable fields (`T | null | undefined`).

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Serialize `Some(None)` as JSON `null` and `Some(Some(v))` as `v`.
///
/// Combine with `default` and `skip_serializing_if = "Option::is_none"` so a
/// missing field stays omitted.
pub(crate) mod double_option {
    use super::{Deserialize, Deserializer, Serialize, Serializer};

    #[expect(
        clippy::option_option,
        reason = "the inner Option is the field's own nullability; the outer Option distinguishes a present field (Some) from an absent one (None), matching the TS `T | null | undefined` contract"
    )]
    #[expect(
        clippy::ref_option,
        reason = "serde field helpers receive &Option<Option<T>>; Option<&Option<T>> would not match the derive-generated call"
    )]
    pub(crate) fn serialize<S, T>(
        value: &Option<Option<T>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
        T: Serialize,
    {
        match value {
            Some(inner) => inner.serialize(serializer),
            None => serializer.serialize_none(),
        }
    }

    #[expect(
        clippy::option_option,
        reason = "the inner Option is the field's own nullability; the outer Option distinguishes a present field (Some) from an absent one (None), matching the TS `T | null | undefined` contract"
    )]
    pub(crate) fn deserialize<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
    where
        D: Deserializer<'de>,
        T: Deserialize<'de>,
    {
        Ok(Some(Option::deserialize(deserializer)?))
    }
}
