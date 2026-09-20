// SPDX-License-Identifier: AGPL-3.0-or-later
use axum::{
    body::{Body, Bytes},
    extract::Request,
    http::{StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use http_body::{Body as HttpBody, Frame, SizeHint};
use std::{
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(super) async fn run(request: Request, next: Next, slots: Arc<Semaphore>) -> Response {
    let Ok(permit) = slots.try_acquire_owned() else {
        // An empty 503 is indistinguishable from an outage. Name the reason
        // and tell the client when to come back.
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::RETRY_AFTER, "1"),
            ],
            r#"{"error":"server busy"}"#,
        )
            .into_response();
    };
    let response = match tokio::time::timeout(Duration::from_secs(30), next.run(request)).await {
        Ok(response) => response,
        Err(_) => StatusCode::GATEWAY_TIMEOUT.into_response(),
    };
    let (parts, inner) = response.into_parts();
    Response::from_parts(
        parts,
        Body::new(AdmittedBody {
            inner,
            _permit: permit,
        }),
    )
}
struct AdmittedBody {
    inner: Body,
    _permit: OwnedSemaphorePermit,
}
impl HttpBody for AdmittedBody {
    type Data = Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        Pin::new(&mut self.inner).poll_frame(cx)
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        reason = "a test asserts its own preconditions before unwrapping"
    )]
    use super::*;
    use axum::{Router, body::to_bytes, http::Request, routing::get};
    use tower::ServiceExt;

    /// A rejected request explains itself instead of returning an empty body.
    #[tokio::test]
    async fn a_full_queue_rejects_with_a_readable_body() {
        let slots = Arc::new(Semaphore::new(1));
        let held = Arc::clone(&slots).try_acquire_owned().unwrap();
        let app =
            Router::new()
                .route("/", get(|| async { "ok" }))
                .layer(axum::middleware::from_fn(move |request, next| {
                    run(request, next, Arc::clone(&slots))
                }));
        let response = app
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers().get("retry-after").unwrap(), "1");
        let bytes = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(&bytes[..], br#"{"error":"server busy"}"#);
        drop(held);
    }
}
