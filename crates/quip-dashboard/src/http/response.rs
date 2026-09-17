// SPDX-License-Identifier: AGPL-3.0-or-later
use super::{HttpState, routes::ApiError};
use axum::{
    body::{Body, Bytes},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use serde_json::json;
use std::{io, sync::Arc};
use tokio::sync::OwnedSemaphorePermit;

pub(super) const BYTES: usize = 2 * 1024 * 1024;
struct CappedWriter(Vec<u8>);
impl io::Write for CappedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > BYTES {
            return Err(io::Error::other("response capacity exceeded"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
struct Charged {
    bytes: Vec<u8>,
    _permit: OwnedSemaphorePermit,
}
impl AsRef<[u8]> for Charged {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}
pub(super) fn capacity() -> ApiError {
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({"error":"response capacity exceeded"}),
    )
}
pub(super) fn encode<T: Serialize>(state: &HttpState, value: &T) -> Result<Bytes, ApiError> {
    let mut writer = CappedWriter(Vec::new());
    serde_json::to_writer(&mut writer, value).map_err(|error| {
        if error.is_io() {
            capacity()
        } else {
            ApiError::from(error)
        }
    })?;
    let count = writer.0.len();
    let permit = Arc::clone(&state.response_budget)
        .try_acquire_many_owned(u32::try_from(count).map_err(|_| capacity())?)
        .map_err(|_| capacity())?;
    Ok(Bytes::from_owner(Charged {
        bytes: writer.0,
        _permit: permit,
    }))
}
pub(super) fn json<T: Serialize>(state: &HttpState, value: &T) -> Result<Response, ApiError> {
    let bytes = encode(state, value)?;
    Ok((
        [(header::CONTENT_TYPE, "application/json")],
        Body::from(bytes),
    )
        .into_response())
}
