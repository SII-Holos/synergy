use serde::Deserialize;

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
    pub mode: String,
    #[serde(default, rename = "allowLocalBinding")]
    pub allow_local_binding: bool,
    #[serde(default, rename = "allowedUnixSockets")]
    pub allowed_unix_sockets: Vec<String>,
    #[serde(default, rename = "wfpEnabled")]
    pub wfp_enabled: bool,
}

#[derive(Deserialize, Debug, Clone)]
pub struct PermissionProfile {
    #[serde(rename = "fileSystem")]
    pub file_system: FileSystemPolicy,
    pub network: NetworkPolicy,
}

pub fn load_permission_profile(
    path: &str,
) -> Result<PermissionProfile, Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(path)?;
    let profile: PermissionProfile = serde_json::from_str(&content)?;
    validate_permission_profile(&profile)?;
    Ok(profile)
}

pub fn parse_config() -> Result<PermissionProfile, Box<dyn std::error::Error>> {
    let profile: PermissionProfile = serde_json::from_reader(std::io::stdin().lock())?;
    validate_permission_profile(&profile)?;
    Ok(profile)
}

pub fn validate_permission_profile(profile: &PermissionProfile) -> Result<(), String> {
    // Read optional fields here so unsupported-but-valid policy dimensions are
    // acknowledged by the helper contract even before their enforcement slices
    // are wired into the Windows runtime.
    let _ = profile.file_system.unreadable_globs.len();
    let _ = profile.network.allow_local_binding;
    let _ = profile.network.allowed_unix_sockets.len();

    if profile.file_system.workspace.trim().is_empty() {
        return Err("fileSystem.workspace is required and cannot be empty".into());
    }
    match profile.network.mode.as_str() {
        "full" | "restricted" | "proxy_only" => Ok(()),
        "" => Err("network.mode is required and cannot be empty".into()),
        other => Err(format!(
            "network.mode must be one of full, restricted, proxy_only; got {other}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_profile_json() -> &'static str {
        r#"{
            "fileSystem": {
                "workspace": "C:\\Users\\test\\project",
                "readableRoots": ["C:\\Users\\test\\project", "C:\\Windows\\System32"],
                "writableRoots": ["C:\\Users\\test\\project"],
                "readOnlySubpaths": ["C:\\Users\\test\\project\\.git"],
                "unreadableGlobs": [],
                "protectedMetadataNames": [".git", ".synergy"],
                "protectedPaths": ["C:\\Users\\test\\.ssh", "C:\\Users\\test\\.aws"],
                "dataDenyRoots": ["C:\\Users\\test"],
                "includePlatformDefaults": true
            },
            "network": {
                "mode": "restricted",
                "allowLocalBinding": false,
                "allowedUnixSockets": []
            }
        }"#
    }

    #[test]
    fn parses_permission_profile_json() {
        let profile: PermissionProfile = serde_json::from_str(valid_profile_json()).unwrap();
        assert_eq!(profile.file_system.workspace, "C:\\Users\\test\\project");
        assert_eq!(profile.network.mode, "restricted");
    }

    #[test]
    fn rejects_empty_workspace() {
        let mut profile: PermissionProfile = serde_json::from_str(valid_profile_json()).unwrap();
        profile.file_system.workspace.clear();
        let err = validate_permission_profile(&profile).unwrap_err();
        assert!(err.contains("fileSystem.workspace"));
    }

    #[test]
    fn rejects_missing_workspace() {
        let json = r#"{
            "fileSystem": {
                "readableRoots": [],
                "writableRoots": [],
                "readOnlySubpaths": [],
                "unreadableGlobs": [],
                "protectedMetadataNames": [],
                "protectedPaths": [],
                "dataDenyRoots": [],
                "includePlatformDefaults": false
            },
            "network": {
                "mode": "restricted",
                "allowLocalBinding": false,
                "allowedUnixSockets": []
            }
        }"#;
        let result: Result<PermissionProfile, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn rejects_invalid_network_mode() {
        let mut profile: PermissionProfile = serde_json::from_str(valid_profile_json()).unwrap();
        profile.network.mode = "lan_party".into();
        let err = validate_permission_profile(&profile).unwrap_err();
        assert!(err.contains("full, restricted, proxy_only"));
    }

    #[test]
    fn rejects_empty_network_mode() {
        let mut profile: PermissionProfile = serde_json::from_str(valid_profile_json()).unwrap();
        profile.network.mode.clear();
        let err = validate_permission_profile(&profile).unwrap_err();
        assert!(err.contains("network.mode"));
    }

    #[test]
    fn accepts_all_valid_network_modes() {
        for mode in ["full", "restricted", "proxy_only"] {
            let mut profile: PermissionProfile =
                serde_json::from_str(valid_profile_json()).unwrap();
            profile.network.mode = mode.to_string();
            validate_permission_profile(&profile).unwrap();
        }
    }

    #[test]
    fn parses_profile_with_all_filesystem_fields() {
        let profile: PermissionProfile = serde_json::from_str(valid_profile_json()).unwrap();
        assert_eq!(profile.file_system.readable_roots.len(), 2);
        assert_eq!(profile.file_system.writable_roots.len(), 1);
        assert_eq!(profile.file_system.read_only_subpaths.len(), 1);
        assert_eq!(profile.file_system.protected_metadata_names.len(), 2);
        assert_eq!(profile.file_system.protected_paths.len(), 2);
        assert_eq!(profile.file_system.data_deny_roots.len(), 1);
        assert!(profile.file_system.include_platform_defaults);
    }

    // ================================================================
    // Slice: WFP enabled config tests
    //
    // These tests assert the PURE contract of the `wfpEnabled` field
    // in NetworkPolicy. It defaults to false and is explicitly parsed
    // when present. No FFI — tests run on any platform.
    //
    // Expected RED failures (compile-time or assertion):
    //   - field `wfp_enabled` not found on `NetworkPolicy`
    //   - deserializing without wfpEnabled sets it to true (wrong default)
    // ================================================================

    #[test]
    fn wfp_enabled_defaults_to_false() {
        let profile: PermissionProfile = serde_json::from_str(valid_profile_json()).unwrap();
        assert!(
            !profile.network.wfp_enabled,
            "wfpEnabled must default to false when absent from JSON"
        );
    }

    #[test]
    fn wfp_enabled_parses_true() {
        let json = r#"{
            "fileSystem": {
                "workspace": "C:\\sandbox",
                "readableRoots": [],
                "writableRoots": [],
                "readOnlySubpaths": [],
                "unreadableGlobs": [],
                "protectedMetadataNames": [],
                "protectedPaths": [],
                "dataDenyRoots": [],
                "includePlatformDefaults": false
            },
            "network": {
                "mode": "restricted",
                "wfpEnabled": true,
                "allowLocalBinding": false,
                "allowedUnixSockets": []
            }
        }"#;
        let profile: PermissionProfile = serde_json::from_str(json).unwrap();
        assert!(
            profile.network.wfp_enabled,
            "wfpEnabled must parse as true when set in JSON"
        );
    }
}
