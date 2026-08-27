use std::{collections::HashMap, sync::Arc, time::Duration};
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[allow(dead_code)]
pub enum Grade {
    A,
    B,
    #[allow(dead_code)]
    C,
    #[allow(dead_code)]
    F,
}

impl Grade {
    pub fn as_char(&self) -> char {
        match self {
            Grade::A => 'A',
            Grade::B => 'B',
            Grade::C => 'C',
            Grade::F => 'F',
        }
    }
}

pub struct GradeInfo {
    pub slug: &'static str,
    pub grade: Grade,
    pub spoof_origin: &'static str,
    pub test_path: &'static str,
    pub test_method: &'static str,
    pub cache_ttl_ms: u64,
    pub notes: &'static str,
}

pub static GRADES: &[GradeInfo] = &[
    GradeInfo {
        slug: "gamma",
        grade: Grade::A,
        spoof_origin: "https://polymarket.com",
        test_path: "events?limit=1",
        test_method: "GET",
        cache_ttl_ms: 1000,
        notes: "Polymarket Gamma API",
    },
    GradeInfo {
        slug: "clob",
        grade: Grade::A,
        spoof_origin: "https://polymarket.com",
        test_path: "time",
        test_method: "GET",
        cache_ttl_ms: 500,
        notes: "Polymarket CLOB API",
    },
    GradeInfo {
        slug: "polymarket",
        grade: Grade::A,
        spoof_origin: "https://polymarket.com",
        test_path: "events?limit=1",
        test_method: "GET",
        cache_ttl_ms: 1000,
        notes: "Polymarket Markets",
    },
    GradeInfo {
        slug: "polymarket-clob",
        grade: Grade::A,
        spoof_origin: "https://polymarket.com",
        test_path: "time",
        test_method: "GET",
        cache_ttl_ms: 500,
        notes: "Polymarket Orderbook",
    },
    GradeInfo {
        slug: "polymarket-data",
        grade: Grade::A,
        spoof_origin: "https://polymarket.com",
        test_path: "",
        test_method: "GET",
        cache_ttl_ms: 1000,
        notes: "Polymarket Data API",
    },
    GradeInfo {
        slug: "polymarket-perps",
        grade: Grade::A,
        spoof_origin: "https://polymarket.com",
        test_path: "",
        test_method: "GET",
        cache_ttl_ms: 500,
        notes: "Polymarket Perps",
    },
    GradeInfo {
        slug: "binance",
        grade: Grade::A,
        spoof_origin: "https://www.binance.com",
        test_path: "api/v3/ping",
        test_method: "GET",
        cache_ttl_ms: 1000,
        notes: "Binance Spot API",
    },
    GradeInfo {
        slug: "coinbase",
        grade: Grade::A,
        spoof_origin: "https://www.coinbase.com",
        test_path: "v2/time",
        test_method: "GET",
        cache_ttl_ms: 1000,
        notes: "Coinbase API",
    },
    GradeInfo {
        slug: "kraken",
        grade: Grade::A,
        spoof_origin: "https://www.kraken.com",
        test_path: "0/public/Time",
        test_method: "GET",
        cache_ttl_ms: 1000,
        notes: "Kraken Public API",
    },
    GradeInfo {
        slug: "hyperliquid",
        grade: Grade::A,
        spoof_origin: "https://app.hyperliquid.xyz",
        test_path: "info",
        test_method: "POST",
        cache_ttl_ms: 500,
        notes: "Hyperliquid Info API",
    },
    GradeInfo {
        slug: "bybit",
        grade: Grade::A,
        spoof_origin: "https://www.bybit.com",
        test_path: "v5/market/time",
        test_method: "GET",
        cache_ttl_ms: 1000,
        notes: "Bybit V5 Market Time",
    },
    GradeInfo {
        slug: "okx",
        grade: Grade::A,
        spoof_origin: "https://www.okx.com",
        test_path: "api/v5/public/time",
        test_method: "GET",
        cache_ttl_ms: 1000,
        notes: "OKX Public Time",
    },
    GradeInfo {
        slug: "deribit",
        grade: Grade::A,
        spoof_origin: "https://www.deribit.com",
        test_path: "api/v2/public/get_time",
        test_method: "GET",
        cache_ttl_ms: 1000,
        notes: "Deribit Public Time",
    },
    GradeInfo {
        slug: "coingecko",
        grade: Grade::B,
        spoof_origin: "https://www.coingecko.com",
        test_path: "api/v3/ping",
        test_method: "GET",
        cache_ttl_ms: 5000,
        notes: "CoinGecko Ping",
    },
];

pub fn spoof_for(exchange: &str) -> &'static str {
    GRADES
        .iter()
        .find(|g| g.slug == exchange)
        .map(|g| g.spoof_origin)
        .unwrap_or("")
}

pub fn ttl_for(exchange: &str) -> Duration {
    GRADES
        .iter()
        .find(|g| g.slug == exchange)
        .map(|g| Duration::from_millis(g.cache_ttl_ms))
        .unwrap_or(Duration::ZERO)
}

pub fn grade_for(exchange: &str) -> Option<Grade> {
    GRADES.iter().find(|g| g.slug == exchange).map(|g| g.grade)
}

#[derive(Serialize, Debug, Clone)]
pub struct TestResult {
    pub exchange: String,
    pub success: bool,
    pub status_code: u16,
    pub latency_ms: u64,
    pub error: Option<String>,
}

pub async fn run_test(
    client: Arc<reqwest::Client>,
    upstreams: Arc<HashMap<String, String>>,
    exchange: &str,
) -> Option<TestResult> {
    let base = upstreams.get(exchange)?;
    let grade_info = GRADES.iter().find(|g| g.slug == exchange);
    let test_path = grade_info.map(|g| g.test_path).unwrap_or("");
    let test_method = grade_info.map(|g| g.test_method).unwrap_or("GET");
    let spoof = grade_info.map(|g| g.spoof_origin).unwrap_or("");

    let url = if test_path.is_empty() {
        base.clone()
    } else {
        format!("{}/{}", base.trim_end_matches('/'), test_path.trim_start_matches('/'))
    };

    let start = std::time::Instant::now();
    let mut req = match test_method {
        "POST" => client.post(&url),
        _ => client.get(&url),
    };

    if !spoof.is_empty() {
        req = req.header("origin", spoof).header("referer", format!("{}/", spoof));
    }

    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let latency_ms = start.elapsed().as_millis() as u64;
            Some(TestResult {
                exchange: exchange.to_string(),
                success: resp.status().is_success() || resp.status().is_redirection(),
                status_code: status,
                latency_ms,
                error: None,
            })
        }
        Err(e) => {
            let latency_ms = start.elapsed().as_millis() as u64;
            Some(TestResult {
                exchange: exchange.to_string(),
                success: false,
                status_code: 0,
                latency_ms,
                error: Some(e.to_string()),
            })
        }
    }
}

pub async fn run_tests(
    client: Arc<reqwest::Client>,
    upstreams: Arc<HashMap<String, String>>,
) -> Vec<TestResult> {
    let mut tasks = Vec::new();
    for g in GRADES {
        let c = Arc::clone(&client);
        let u = Arc::clone(&upstreams);
        let slug = g.slug.to_string();
        tasks.push(tokio::spawn(async move {
            run_test(c, u, &slug).await
        }));
    }
    let mut results = Vec::new();
    for t in tasks {
        if let Ok(Some(r)) = t.await {
            results.push(r);
        }
    }
    results
}
