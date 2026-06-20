use serde::Deserialize;

// Mirrors SynergySandboxPermissionProfile from TS policy-engine.ts
// JSON format is the interop contract between TS and Rust helpers.

#[derive(Deserialize, Debug)]
pub struct FileSystemPolicy {
    pub workspace: String,
    #[serde(default)]
    pub readable_roots: Vec<String>,
    #[serde(default)]
    pub writable_roots: Vec<String>,
    #[serde(default)]
    pub read_only_subpaths: Vec<String>,
    #[serde(default)]
    pub protected_paths: Vec<String>,
    #[serde(default)]
    pub data_deny_roots: Vec<String>,
    #[serde(default)]
    pub include_platform_defaults: bool,
}

#[derive(Deserialize, Debug)]
pub struct NetworkPolicy {
    pub mode: String, // "full" | "restricted" | "proxy_only"
    #[serde(default)]
    pub allow_local_binding: bool,
    #[serde(default)]
    pub allowed_unix_sockets: Vec<String>,
}

#[derive(Deserialize, Debug)]
pub struct PermissionProfile {
    #[serde(rename = "fileSystem")]
    pub file_system: FileSystemPolicy,
    pub network: NetworkPolicy,
}

/// Load and parse the JSON permission profile from disk.
pub fn load_permission_profile(
    path: &str,
) -> Result<PermissionProfile, Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(path)?;
    let profile: PermissionProfile = serde_json::from_str(&content)?;
    Ok(profile)
}
