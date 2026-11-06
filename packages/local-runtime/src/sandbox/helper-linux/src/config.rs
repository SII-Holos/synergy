use serde::Deserialize;

use crate::error::HelperError;

// Mirrors SynergySandboxPermissionProfile from TS policy-engine.ts.
// JSON format is the interop contract between TS and Rust helpers.

#[derive(Deserialize, Debug, Clone)]
pub struct FileSystemPolicy {
    pub workspace: String,
    #[serde(default, rename = "readableRoots")]
    pub readable_roots: Vec<String>,
    #[serde(default, rename = "writableRoots")]
    pub writable_roots: Vec<String>,
    #[serde(default, rename = "readOnlySubpaths")]
    pub read_only_subpaths: Vec<String>,
    #[serde(default, rename = "unreadableGlobs")]
    pub unreadable_globs: Vec<String>,
    #[serde(default, rename = "protectedMetadataNames")]
    pub protected_metadata_names: Vec<String>,
    #[serde(default, rename = "protectedPaths")]
    pub protected_paths: Vec<String>,
    #[serde(default, rename = "dataDenyRoots")]
    pub data_deny_roots: Vec<String>,
    #[serde(default, rename = "includePlatformDefaults")]
    pub include_platform_defaults: bool,
}

#[derive(Deserialize, Debug, Clone)]
pub struct NetworkPolicy {
    pub mode: String, // "full" | "restricted" | "proxy_only"
    #[serde(default, rename = "allowLocalBinding")]
    pub allow_local_binding: bool,
    #[serde(default, rename = "allowedUnixSockets")]
    pub allowed_unix_sockets: Vec<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct PermissionProfile {
    #[serde(rename = "fileSystem")]
    pub file_system: FileSystemPolicy,
    pub network: NetworkPolicy,
}

/// Load, parse, and validate the JSON permission profile from disk.
pub fn load_permission_profile(
    path: &str,
) -> Result<PermissionProfile, Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(path)?;
    let profile: PermissionProfile = serde_json::from_str(&content)?;
    validate_permission_profile(&profile)?;
    Ok(profile)
}

/// Validate the minimum policy contract required before invoking bwrap/seccomp.
pub fn validate_permission_profile(profile: &PermissionProfile) -> Result<(), HelperError> {
    if profile.file_system.workspace.trim().is_empty() {
        return Err(HelperError::Config(
            "fileSystem.workspace is required and cannot be empty".into(),
        ));
    }

    match profile.network.mode.as_str() {
        "full" | "restricted" | "proxy_only" => Ok(()),
        "" => Err(HelperError::Config(
            "network.mode is required and cannot be empty".into(),
        )),
        other => Err(HelperError::Config(format!(
            "network.mode must be one of full, restricted, proxy_only; got {other}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_profile() -> PermissionProfile {
        PermissionProfile {
            file_system: FileSystemPolicy {
                workspace: "/ws".into(),
                readable_roots: vec![],
                writable_roots: vec![],
                read_only_subpaths: vec![],
                unreadable_globs: vec![],
                protected_metadata_names: vec![],
                protected_paths: vec![],
                data_deny_roots: vec![],
                include_platform_defaults: false,
            },
            network: NetworkPolicy {
                mode: "restricted".into(),
                allow_local_binding: false,
                allowed_unix_sockets: vec![],
            },
        }
    }

    #[test]
    fn rejects_missing_file_system_workspace() {
        let mut profile = valid_profile();
        profile.file_system.workspace.clear();
        let err = validate_permission_profile(&profile).unwrap_err();
        assert!(err.to_string().contains("fileSystem.workspace"));
    }

    #[test]
    fn rejects_missing_network_mode() {
        let mut profile = valid_profile();
        profile.network.mode.clear();
        let err = validate_permission_profile(&profile).unwrap_err();
        assert!(err.to_string().contains("network.mode"));
    }

    #[test]
    fn rejects_unknown_network_mode() {
        let mut profile = valid_profile();
        profile.network.mode = "lan_party".into();
        let err = validate_permission_profile(&profile).unwrap_err();
        assert!(err.to_string().contains("full, restricted, proxy_only"));
    }

    #[test]
    fn accepts_valid_profile() {
        let profile = valid_profile();
        validate_permission_profile(&profile).expect("valid profile should pass");
    }
}
