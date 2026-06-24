pub mod crypto;
pub mod sandbox;
pub mod server;
pub mod supervisor;
pub mod tokenizer;
pub mod vector;

pub mod zome {
    include!(concat!(env!("OUT_DIR"), "/zome.rs"));
}

use std::path::PathBuf;

use anyhow::bail;

pub fn sanitize_agent_id(agent_id: &str) -> anyhow::Result<String> {
    if agent_id.is_empty() || agent_id.len() > 64 {
        bail!("invalid agent_id length");
    }
    if agent_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        Ok(agent_id.to_string())
    } else {
        bail!("agent_id contains invalid characters")
    }
}

pub fn project_root() -> anyhow::Result<PathBuf> {
    let mut dir = std::env::current_dir()?;
    loop {
        if dir.join("pnpm-workspace.yaml").exists() || dir.join("package.json").exists() {
            return Ok(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    Ok(std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("CLOUDMIND_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("cloudmind-zome")
}
