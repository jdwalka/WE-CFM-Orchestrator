mod cache;
mod codec;
mod config;
mod grades;
mod proxy;
mod utils;

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU16, Ordering},
        Arc,
    },
    time::Duration,
};

use axum::{
    body::Body,
    extract::{Path, Query, Request, State},
    http::StatusCode,
    response::Response,
    routing::{any, delete, get},
    Router,
};
use http_body_util::BodyExt;
use tower_http::{
    catch_panic::CatchPanicLayer,
    cors::{Any, CorsLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};
use tracing::info;

use cache::ResponseCache;

// ─── Application state ──────────────────────────────────────────────────────────

#[derive(Clone)]
struct AppState {
    client:    Arc<reqwest::Client>,
    upstreams: Arc<HashMap<String, String>>,
    cache:     Arc<ResponseCache>,
}

// ─── Active port ────────────────────────────────────────────────────────────────

static ACTIVE_PORT: AtomicU16 = AtomicU16::new(3010);

// ─── Entry point ────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "we_crypto_proxy=info,tower_http=warn".into()),
        )
        .init();

    config::load()?;
    let cfg       = config::get();
    let client    = Arc::new(build_client(cfg.server.timeout_secs)?);
    let upstreams = Arc::new(cfg.exchanges.clone());
    let cache     = Arc::new(ResponseCache::new(512));
    let state     = AppState { client, upstreams, cache };

    let app = Router::new()
        // ── Utility ──────────────────────────────────────────────────────────
        .route("/health",         get(health))
        .route("/port",           get(port_handler))
        // ── Grade & test ─────────────────────────────────────────────────────
        .route("/grades",         get(grades_handler))
        .route("/test",           get(test_all_handler))
        .route("/test/:exchange", get(test_one_handler))
        // ── Cache management ─────────────────────────────────────────────────
        .route("/cache/stats",    get(cache_stats_handler))
        .route("/cache",          delete(cache_clear_handler))
        // ── Proxy ────────────────────────────────────────────────────────────
        .route("/proxy",          any(direct_proxy))
        .route("/:exchange",      any(exchange_proxy_root))
        .route("/:exchange/*path", any(exchange_proxy))
        .with_state(state)
        .layer(CatchPanicLayer::new())
        .layer(TimeoutLayer::new(Duration::from_secs(15)))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any)
                .expose_headers(Any)
                .max_age(Duration::from_secs(86400)),
        )
        .layer(TraceLayer::new_for_http());

    let (listener, port) = bind_cascade().await?;
    write_port_file(port);
    ACTIVE_PORT.store(port, Ordering::Relaxed);
    info!("WE-Crypto proxy  →  http://127.0.0.1:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}

// ─── Port binding ────────────────────────────────────────────────────────────────

async fn bind_cascade() -> anyhow::Result<(tokio::net::TcpListener, u16)> {
    let up:    Vec<u16> = (3011u16..=3020).collect();
    let down:  Vec<u16> = (3000u16..=3009).rev().collect();
    let ultra: &[u16]   = &[8080, 8000, 4000, 5000, 9000];
    let candidates: Vec<u16> = std::iter::once(3010u16)
        .chain(up)
        .chain(down)
        .chain(ultra.iter().copied())
        .collect();
    for &port in &candidates {
        if let Ok(l) = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}")).await {
            return Ok((l, port));
        }
    }
    anyhow::bail!("no available port in 3000-3020 or ultra-fallbacks")
}

fn write_port_file(port: u16) {
    let path = std::env::temp_dir().join("wecrypto-proxy.port");
    std::fs::write(&path, port.to_string()).ok();
    info!("Port file → {}", path.display());
}

// ─── Handlers ───────────────────────────────────────────────────────────────────

async fn health() -> &'static str {
    "OK"
}

async fn port_handler() -> axum::Json<serde_json::Value> {
    let port = ACTIVE_PORT.load(Ordering::Relaxed);
    axum::Json(serde_json::json!({ "port": port }))
}

/// `GET /grades` — return grade metadata for all exchanges.
async fn grades_handler() -> axum::Json<serde_json::Value> {
    let list: Vec<serde_json::Value> = grades::GRADES
        .iter()
        .map(|g| {
            serde_json::json!({
                "exchange":     g.slug,
                "grade":        g.grade.as_char().to_string(),
                "spoof_origin": g.spoof_origin,
                "test_path":    g.test_path,
                "test_method":  g.test_method,
                "cache_ttl_ms": g.cache_ttl_ms,
                "notes":        g.notes,
            })
        })
        .collect();
    axum::Json(serde_json::Value::Array(list))
}

/// `GET /test` — run all grade health tests concurrently.
async fn test_all_handler(State(state): State<AppState>) -> axum::Json<serde_json::Value> {
    let results = grades::run_tests(Arc::clone(&state.client), Arc::clone(&state.upstreams)).await;
    axum::Json(serde_json::json!({ "results": results }))
}

/// `GET /test/:exchange` — run a single exchange health test.
async fn test_one_handler(
    State(state): State<AppState>,
    Path(exchange): Path<String>,
) -> Response {
    match grades::run_test(Arc::clone(&state.client), Arc::clone(&state.upstreams), &exchange).await {
        Some(r) => {
            let body = serde_json::to_string(&r).unwrap_or_default();
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "application/json")
                .header("access-control-allow-origin", "*")
                .body(Body::from(body))
                .unwrap()
        }
        None => err_resp(StatusCode::NOT_FOUND, &format!("unknown exchange '{exchange}'")),
    }
}

/// `GET /cache/stats` — return cache hit/miss/eviction counters.
async fn cache_stats_handler(State(state): State<AppState>) -> axum::Json<serde_json::Value> {
    let stats = state.cache.stats();
    axum::Json(serde_json::to_value(stats).unwrap_or_default())
}

/// `DELETE /cache` — clear the entire cache.
async fn cache_clear_handler(State(state): State<AppState>) -> axum::Json<serde_json::Value> {
    state.cache.clear();
    axum::Json(serde_json::json!({ "cleared": true }))
}

// ─── Proxy handlers ──────────────────────────────────────────────────────────────

async fn exchange_proxy(
    State(state): State<AppState>,
    Path((exchange, path)): Path<(String, String)>,
    req: Request,
) -> Response {
    let Some(base) = state.upstreams.get(&exchange).cloned() else {
        return err_resp(StatusCode::NOT_FOUND, &format!("unknown exchange '{exchange}'"));
    };
    forward_exchange(&state, &exchange, &base, &path, req).await
}

/// `/:exchange` with no trailing path (e.g. `POST /solana/`, `/xrpl/` hit the
/// router as an empty path on some axum versions and 404 without this).
/// Same as exchange_proxy with an empty path.
async fn exchange_proxy_root(
    State(state): State<AppState>,
    Path(exchange): Path<String>,
    req: Request,
) -> Response {
    let Some(base) = state.upstreams.get(&exchange).cloned() else {
        return err_resp(StatusCode::NOT_FOUND, &format!("unknown exchange '{exchange}'"));
    };
    forward_exchange(&state, &exchange, &base, "", req).await
}

async fn forward_exchange(
    state:    &AppState,
    exchange: &str,
    base:     &str,
    path:     &str,
    req:      Request,
) -> Response {
    let spoof     = grades::spoof_for(exchange);
    let cache_ttl = grades::ttl_for(exchange);
    let grade     = grades::grade_for(exchange)
        .map(|g| g.as_char())
        .unwrap_or('B');
    forward_to(state, base, path, req, spoof, cache_ttl, grade).await
}

async fn direct_proxy(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    req: Request,
) -> Response {
    let Some(url) = params.get("url").cloned() else {
        return err_resp(StatusCode::BAD_REQUEST, "missing ?url= param");
    };
    if !url.starts_with("https://") {
        return err_resp(StatusCode::BAD_REQUEST, "url must start with https://");
    }
    let method  = req.method().clone();
    let headers = req.headers().clone();
    let body    = drain(req).await;
    proxy::forward(
        &state.client, &url, method, &headers, body,
        /*spoof=*/ "", &state.cache, Duration::ZERO, 'B',
    )
    .await
}

async fn forward_to(
    state:     &AppState,
    base:      &str,
    path:      &str,
    req:       Request,
    spoof:     &str,
    cache_ttl: Duration,
    grade:     char,
) -> Response {
    let query   = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    let url     = format!("{base}/{path}{query}");
    let method  = req.method().clone();
    let headers = req.headers().clone();
    let body    = drain(req).await;
    proxy::forward(&state.client, &url, method, &headers, body, spoof, &state.cache, cache_ttl, grade).await
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────

async fn drain(req: Request) -> bytes::Bytes {
    req.into_body()
        .collect()
        .await
        .map(|c| c.to_bytes())
        .unwrap_or_default()
}

fn err_resp(status: StatusCode, msg: &str) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("access-control-allow-origin", "*")
        .body(Body::from(format!(r#"{{"error":"{msg}"}}"#)))
        .unwrap()
}

fn build_client(timeout_secs: u64) -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36")
        .timeout(Duration::from_secs(timeout_secs))
        .cookie_store(true)
        .pool_max_idle_per_host(8)
        .tcp_keepalive(Duration::from_secs(60))
        .build()
}
