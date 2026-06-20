use serde::Deserialize;

#[derive(Deserialize, Debug)]
pub struct SandboxConfig {
    pub level: String, // "restricted-token" | "elevated"
    pub mode: String, // "read_only" | "workspace_write"
    pub workspace: String,
    pub execution_cwd: String,
    pub writable_roots: Vec<String>,
    pub read_roots: Vec<String>,
    pub protected_paths: Vec<String>,
    pub data_deny_roots: Vec<String>,
    pub command: String,
    pub args: Vec<String>,
}

pub fn parse_config() -> Result<SandboxConfig, Box<dyn std::error::Error>> {
    let config: SandboxConfig = serde_json::from_reader(std::io::stdin().lock())?;
    Ok(config)
}
