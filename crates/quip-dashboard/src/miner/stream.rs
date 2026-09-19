// SPDX-License-Identifier: AGPL-3.0-or-later
//! Streaming decode of `/api/v1/mining/attempts` bodies in bounded memory.
//!
//! The miner returns every attempt for a solution with no paging, so a long
//! qblock produces a body far larger than the other miner resources. This
//! decoder folds each attempt row into an [`AttemptTrail`] as it arrives and
//! never holds the whole array.

use super::parse::{AttemptTrail, MinerError, envelope_failure};
use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::Value;
use std::{
    cell::Cell,
    fmt,
    io::{self, BufReader, Read},
};

/// Largest single JSON value (one attempt row, or the submission object) the
/// decoder materializes: the same cap as a whole status or stats body. Real
/// rows are well under 1 KiB. The reader counts bytes as its buffer fills, so
/// a value is measured to within one 8 KiB buffer.
pub(super) const VALUE_BYTES: usize = super::client::RESPONSE_BYTES;

/// A decoded attempts body: the submission object and the folded trail.
pub(super) struct AttemptsBody {
    pub(super) submission: Option<Value>,
    pub(super) trail: AttemptTrail,
}

/// Decode an attempts response, unwrapping the `{success, data, error}`
/// envelope the same way [`super::parse::unwrap_envelope`] does.
///
/// # Errors
///
/// Returns [`MinerError::BodyTooLarge`] when one value exceeds
/// [`VALUE_BYTES`], [`MinerError::EnvelopeFailure`] when `success` is false,
/// and [`MinerError::Unparsable`] for malformed JSON.
pub(super) fn decode(reader: impl Read) -> Result<AttemptsBody, MinerError> {
    let guard = Guard::default();
    let counting = Counting {
        inner: reader,
        guard: &guard,
    };
    let mut de = serde_json::Deserializer::from_reader(BufReader::new(counting));
    let mut trail = AttemptTrail::default();
    let top = LevelSeed {
        trail: &mut trail,
        guard: &guard,
    }
    .deserialize(&mut de)
    .and_then(|level| de.end().map(|()| level));
    let top = match top {
        Ok(level) => level,
        Err(_) if guard.oversized.get() => {
            return Err(MinerError::BodyTooLarge { cap: VALUE_BYTES });
        }
        Err(error) => return Err(MinerError::Unparsable(error.to_string())),
    };
    if top.success == Some(false) {
        return Err(envelope_failure(top.error.as_ref()));
    }
    let chosen = top.data.map_or(top.submission, |data| data.submission);
    Ok(AttemptsBody {
        submission: chosen,
        trail,
    })
}

/// Byte accounting shared by the reader and the visitors.
#[derive(Default)]
struct Guard {
    consumed: Cell<usize>,
    /// `consumed` when the value being materialized started, if any.
    value_start: Cell<Option<usize>>,
    oversized: Cell<bool>,
}

impl Guard {
    /// Materialize one value, failing as soon as it passes `VALUE_BYTES`.
    fn value<'de, A: MapAccess<'de>>(&self, map: &mut A) -> Result<Value, A::Error> {
        self.value_start.set(Some(self.consumed.get()));
        let value = map.next_value();
        self.value_start.set(None);
        value
    }
}

/// Counts bytes read and stops the stream once the current value is too large.
struct Counting<'a, R> {
    inner: R,
    guard: &'a Guard,
}

impl<R: Read> Read for Counting<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        let consumed = self.guard.consumed.get().saturating_add(n);
        self.guard.consumed.set(consumed);
        if let Some(start) = self.guard.value_start.get()
            && consumed.saturating_sub(start) > VALUE_BYTES
        {
            self.guard.oversized.set(true);
            return Err(io::Error::other("miner value exceeds the per-value cap"));
        }
        Ok(n)
    }
}

/// One envelope level: the top-level object, or its `data` object.
#[derive(Default)]
struct Level {
    success: Option<bool>,
    error: Option<Value>,
    data: Option<Box<Self>>,
    submission: Option<Value>,
}

struct LevelSeed<'a> {
    trail: &'a mut AttemptTrail,
    guard: &'a Guard,
}

impl<'de> DeserializeSeed<'de> for LevelSeed<'_> {
    type Value = Level;

    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<Level, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for LevelSeed<'_> {
    type Value = Level;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a mining attempts object")
    }

    fn visit_unit<E: de::Error>(self) -> Result<Level, E> {
        Ok(Level::default())
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Level, A::Error> {
        let mut level = Level::default();
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "success" => level.success = self.guard.value(&mut map)?.as_bool(),
                "error" => level.error = Some(self.guard.value(&mut map)?),
                "submission" => level.submission = Some(self.guard.value(&mut map)?),
                "data" => {
                    level.data = Some(Box::new(map.next_value_seed(LevelSeed {
                        trail: &mut *self.trail,
                        guard: self.guard,
                    })?));
                }
                "attempts" => map.next_value_seed(AttemptsSeed {
                    trail: &mut *self.trail,
                    guard: self.guard,
                })?,
                _ => {
                    let _ignored: IgnoredAny = map.next_value()?;
                }
            }
        }
        Ok(level)
    }
}

/// Folds an `attempts` array row by row. A non-array value folds nothing,
/// matching the non-streaming parser.
struct AttemptsSeed<'a> {
    trail: &'a mut AttemptTrail,
    guard: &'a Guard,
}

impl<'de> DeserializeSeed<'de> for AttemptsSeed<'_> {
    type Value = ();

    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for AttemptsSeed<'_> {
    type Value = ();

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an attempts array")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        loop {
            self.guard.value_start.set(Some(self.guard.consumed.get()));
            let row = seq.next_element::<Value>();
            self.guard.value_start.set(None);
            let Some(row) = row? else {
                return Ok(());
            };
            self.trail.push(&row);
        }
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(())
    }

    fn visit_unit<E: de::Error>(self) -> Result<(), E> {
        Ok(())
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<(), E> {
        Ok(())
    }

    fn visit_i64<E: de::Error>(self, _: i64) -> Result<(), E> {
        Ok(())
    }

    fn visit_u64<E: de::Error>(self, _: u64) -> Result<(), E> {
        Ok(())
    }

    fn visit_f64<E: de::Error>(self, _: f64) -> Result<(), E> {
        Ok(())
    }

    fn visit_str<E: de::Error>(self, _: &str) -> Result<(), E> {
        Ok(())
    }
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions report streaming decode regressions"
)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(n: u64) -> Value {
        json!({"iter": n, "best_energy_milli": -(i64::try_from(n).unwrap_or(0)), "result_kind": "rejected", "qpu_access_time_us": 10, "ts_ns": (1_000 + n).to_string()})
    }

    fn body(value: &Value) -> Result<AttemptsBody, MinerError> {
        decode(value.to_string().as_bytes())
    }

    #[test]
    fn folds_every_row_and_keeps_the_newest() -> Result<(), MinerError> {
        let rows: Vec<Value> = (1..=1_200).map(row).collect();
        let decoded =
            body(&json!({"success": true, "data": {"attempts": rows, "submission": {"x": 1}}}))?;
        assert_eq!(decoded.submission, Some(json!({"x": 1})));
        let attempts = decoded.trail.into_newest();
        assert_eq!(attempts.len(), super::super::parse::ATTEMPT_TRAIL_LIMIT);
        assert_eq!(attempts.iter().map(|a| a.iter).max(), Some(1_200));
        Ok(())
    }

    #[test]
    fn unwrapped_body_and_null_attempts_decode() -> Result<(), MinerError> {
        let decoded = body(&json!({"attempts": null, "submission": {"x": 2}}))?;
        assert_eq!(decoded.submission, Some(json!({"x": 2})));
        assert!(decoded.trail.into_newest().is_empty());
        Ok(())
    }

    #[test]
    fn failed_envelope_reports_its_error() {
        let result = body(&json!({"success": false, "error": "nope", "data": null}));
        assert!(matches!(result, Err(MinerError::EnvelopeFailure(message)) if message == "nope"));
    }

    #[test]
    fn oversized_value_stops_the_stream() {
        let padding = "x".repeat(2 * VALUE_BYTES);
        let result =
            body(&json!({"attempts": [{"iter": 1, "best_energy_milli": 0, "padding": padding}]}));
        assert!(matches!(
            result,
            Err(MinerError::BodyTooLarge { cap: VALUE_BYTES })
        ));
    }

    #[test]
    fn truncated_body_is_unparsable() {
        let result = decode(&br#"{"attempts":[{"iter":1"#[..]);
        assert!(matches!(result, Err(MinerError::Unparsable(_))));
    }
}
