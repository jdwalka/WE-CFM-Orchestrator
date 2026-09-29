use std::{collections::HashMap, sync::OnceLock};
use serde::Deserialize;

#[derive(Deserialize, Clone, Debug)]
pub struct Config {
    pub server:    ServerCfg,
    pub exchanges: HashMap<String, String>,
}

#[derive(Deserialize, Clone, Debug)]
#[allow(dead_code)]
pub struct ServerCfg {
    #[allow(dead_code)]
    pub host:         String,
    #[allow(dead_code)]
    pub port:         u16,
    pub timeout_secs: u64,
}

static CONFIG: OnceLock<Config> = OnceLock::new();

// Embedded fallback — binary works without config.toml beside it
const EMBEDDED: &str = include_str!("../config.toml");

pub fn load() -> anyhow::Result<()> {
    let raw = std::fs::read_to_string("config.toml")
        .unwrap_or_else(|_| EMBEDDED.to_string());
    let cfg: Config = toml::from_str(&raw)?;
    CONFIG.set(cfg).map_err(|_| anyhow::anyhow!("config already loaded"))?;
    Ok(())
}

pub fn get() -> &'static Config {
    CONFIG.get().expect("config::load() not called")
}
