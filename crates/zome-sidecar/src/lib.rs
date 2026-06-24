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
    std::env::var("CLOUDMIND_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().expect("home dir").join(".cloudmind-zome"))
}
