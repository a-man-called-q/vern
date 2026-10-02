use axum::{
    Json,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use thiserror::Error;

/// What a handler returns when it cannot answer. It renders as JSON,
/// `{"error":{"code":"forbidden","message":"..."}}`, with the matching status.
// The variants your handlers do not use yet are there for them.
#[allow(dead_code)]
#[derive(Debug, Error)]
pub enum ApiError {
    #[error("{0}")]
    BadRequest(String),
    #[error("A valid access token is required")]
    Unauthorized,
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    NotFound(String),
    /// The request is fine, but the thing is in a state that does not allow it:
    /// a campaign that is not in review cannot be approved.
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    TooManyRequests(String),
    #[error("{0}")]
    Unavailable(String),
    /// Hides the cause from the client; log it where you create the error.
    #[error("Something went wrong")]
    Internal,
}

#[derive(Serialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Serialize)]
struct ErrorDetail {
    code: &'static str,
    message: String,
}

impl ApiError {
    fn status(&self) -> StatusCode {
        match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::TooManyRequests(_) => StatusCode::TOO_MANY_REQUESTS,
            Self::Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    fn code(&self) -> &'static str {
        match self {
            Self::BadRequest(_) => "bad_request",
            Self::Unauthorized => "unauthorized",
            Self::Forbidden(_) => "forbidden",
            Self::NotFound(_) => "not_found",
            Self::Conflict(_) => "conflict",
            Self::TooManyRequests(_) => "too_many_requests",
            Self::Unavailable(_) => "unavailable",
            Self::Internal => "internal",
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = ErrorBody {
            error: ErrorDetail {
                code: self.code(),
                message: self.to_string(),
            },
        };
        let mut response = (self.status(), Json(body)).into_response();
        if matches!(self, Self::Unauthorized) {
            response
                .headers_mut()
                .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use axum::{body::to_bytes, http::header, response::IntoResponse};
    use serde_json::{Value, json};

    use super::ApiError;

    async fn render(error: ApiError) -> (u16, Value) {
        let response = error.into_response();
        let status = response.status().as_u16();
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body is readable");
        (status, serde_json::from_slice(&body).expect("body is JSON"))
    }

    #[tokio::test]
    async fn errors_render_as_json_with_their_status() {
        let (status, body) = render(ApiError::Forbidden("Needs the publisher role".into())).await;
        assert_eq!(status, 403);
        assert_eq!(
            body,
            json!({"error": {"code": "forbidden", "message": "Needs the publisher role"}})
        );

        let (status, body) = render(ApiError::NotFound("No such venue".into())).await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (404, Some("not_found"))
        );

        let (status, body) = render(ApiError::BadRequest("name is required".into())).await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (400, Some("bad_request"))
        );

        let (status, body) = render(ApiError::Conflict("Already approved".into())).await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (409, Some("conflict"))
        );

        let (status, body) = render(ApiError::TooManyRequests("Slow down".into())).await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (429, Some("too_many_requests"))
        );
    }

    #[tokio::test]
    async fn internal_errors_do_not_leak_a_cause() {
        let (status, body) = render(ApiError::Internal).await;
        assert_eq!(status, 500);
        assert_eq!(body["error"]["message"], "Something went wrong");
    }

    #[test]
    fn unauthorized_asks_for_a_bearer_token() {
        let response = ApiError::Unauthorized.into_response();
        assert_eq!(response.status(), 401);
        assert_eq!(response.headers()[header::WWW_AUTHENTICATE], "Bearer");
    }
}
