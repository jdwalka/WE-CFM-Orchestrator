use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
use axum::http::{HeaderMap, StatusCode};
use bytes::Bytes;
use dashmap::DashMap;
use serde::Serialize;

#[derive(Clone)]
pub struct CachedItem {
    pub body: Bytes,
    pub headers: HeaderMap,
    pub status: StatusCode,
    pub expires_at: Instant,
}

#[derive(Serialize, Default, Debug, Clone)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub entries: usize,
    pub evictions: u64,
}

pub struct ResponseCache {
    items: DashMap<String, CachedItem>,
    max_capacity: usize,
    hits: AtomicU64,
    misses: AtomicU64,
    evictions: AtomicU64,
}

impl ResponseCache {
    pub fn new(max_capacity: usize) -> Self {
        Self {
            items: DashMap::new(),
            max_capacity,
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
            evictions: AtomicU64::new(0),
        }
    }

    pub fn get(&self, key: &str) -> Option<(Bytes, HeaderMap, StatusCode)> {
        if let Some(entry) = self.items.get(key) {
            if Instant::now() < entry.expires_at {
                self.hits.fetch_add(1, Ordering::Relaxed);
                return Some((entry.body.clone(), entry.headers.clone(), entry.status));
            }
        }
        self.misses.fetch_add(1, Ordering::Relaxed);
        None
    }

    pub fn insert(&self, key: String, body: Bytes, headers: HeaderMap, status: StatusCode, ttl: Duration) {
        if ttl.is_zero() {
            return;
        }
        if self.items.len() >= self.max_capacity {
            self.items.retain(|_, v| Instant::now() < v.expires_at);
            if self.items.len() >= self.max_capacity {
                if let Some(first_key) = self.items.iter().next().map(|r| r.key().clone()) {
                    self.items.remove(&first_key);
                    self.evictions.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        self.items.insert(
            key,
            CachedItem {
                body,
                headers,
                status,
                expires_at: Instant::now() + ttl,
            },
        );
    }

    pub fn stats(&self) -> CacheStats {
        CacheStats {
            hits: self.hits.load(Ordering::Relaxed),
            misses: self.misses.load(Ordering::Relaxed),
            entries: self.items.len(),
            evictions: self.evictions.load(Ordering::Relaxed),
        }
    }

    pub fn clear(&self) {
        self.items.clear();
    }
}
