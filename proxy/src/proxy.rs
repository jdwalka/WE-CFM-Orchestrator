use std::{sync::Arc, time::Duration};
use axum::{
    body::Body,
    http::{HeaderMap, Method, StatusCode},
    response::Response,
};
use bytes::Bytes;

use crate::{cache::ResponseCache, utils::cors};

pub async fn forward(
    client: &reqwest::Client,
    url: &str,
    method: Method,
    headers: &HeaderMap,
    body: Bytes,
    spoof_origin: &str,
    cache: &Arc<ResponseCache>,
    cache_ttl: Duration,
    _grade: char,
) -> Response {
    // Check cache for GET requests with TTL > 0
    let cache_key = if method == Method::GET && !cache_ttl.is_zero() {
        format!("{}:{}", url, spoof_origin)
    } else {
        String::new()
    };

    if !cache_key.is_empty() {
        if let Some((cached_body, mut cached_headers, status)) = cache.get(&cache_key) {
            cors::inject_cors(&mut cached_headers);
            let mut builder = Response::builder().status(status);
            for (k, v) in cached_headers.iter() {
                builder = builder.header(k, v);
            }
            return builder.body(Body::from(cached_body)).unwrap_or_else(|_| {
                Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .body(Body::empty())
                    .unwrap()
            });
        }
    }

    let outgoing_headers = cors::build_upstream_headers(headers, spoof_origin);
    let reqwest_method = match method {
        Method::GET => reqwest::Method::GET,
        Method::POST => reqwest::Method::POST,
        Method::PUT => reqwest::Method::PUT,
        Method::DELETE => reqwest::Method::DELETE,
        Method::PATCH => reqwest::Method::PATCH,
        Method::HEAD => reqwest::Method::HEAD,
        Method::OPTIONS => reqwest::Method::OPTIONS,
        _ => reqwest::Method::GET,
    };

    let mut req_builder = client.request(reqwest_method, url);
    for (k, v) in outgoing_headers.iter() {
        req_builder = req_builder.header(k, v);
    }
    if !body.is_empty() {
        req_builder = req_builder.body(body);
    }

    match req_builder.send().await {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            let upstream_headers = resp.headers().clone();
            let mut filtered_headers = cors::filter_response_headers(&upstream_headers);

            match resp.bytes().await {
                Ok(resp_bytes) => {
                    if !cache_key.is_empty() && status.is_success() {
                        cache.insert(
                            cache_key,
                            resp_bytes.clone(),
                            filtered_headers.clone(),
                            status,
                            cache_ttl,
                        );
                    }
                    cors::inject_cors(&mut filtered_headers);
                    let mut builder = Response::builder().status(status);
                    for (k, v) in filtered_headers.iter() {
                        builder = builder.header(k, v);
                    }
                    builder.body(Body::from(resp_bytes)).unwrap_or_else(|_| {
                        Response::builder()
                            .status(StatusCode::INTERNAL_SERVER_ERROR)
                            .body(Body::empty())
                            .unwrap()
                    })
                }
                Err(e) => {
                    let mut err_headers = HeaderMap::new();
                    cors::inject_cors(&mut err_headers);
                    Response::builder()
                        .status(StatusCode::BAD_GATEWAY)
                        .header("content-type", "application/json")
                        .body(Body::from(format!(r#"{{"error":"failed to read upstream body: {e}"}}"#)))
                        .unwrap()
                }
            }
        }
        Err(e) => {
            let mut err_headers = HeaderMap::new();
            cors::inject_cors(&mut err_headers);
            Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .header("content-type", "application/json")
                .body(Body::from(format!(r#"{{"error":"upstream request failed: {e}"}}"#)))
                .unwrap()
        }
    }
}
