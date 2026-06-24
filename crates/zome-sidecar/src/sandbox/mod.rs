use tracing::debug;

#[derive(Debug, Default, Clone)]
pub struct Sandbox;

impl Sandbox {
    pub fn new() -> Self {
        Self
    }

    /// Phase 2 skeleton: no actual sandboxing yet.
    pub async fn execute(&self, command: &str, _args: &[&str]) -> anyhow::Result<String> {
        debug!("sandbox execute called with command: {}", command);
        Ok(String::new())
    }
}
