// ================================================================
// WFP filter specification contracts
// ================================================================

/// A single WFP filter specification describing traffic to allow.
#[allow(dead_code)]
pub struct FilterSpec {
    pub key: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub user_condition: &'static str,
}

/// A WFP condition discriminator used in layered filter logic.
#[allow(dead_code)]
pub enum ConditionSpec {
    RemotePort,
    LocalPort,
    IpProtocol,
    RemoteAddr,
    LocalAddr,
}

/// WFP Filtering Layer identifiers (constants from fwpmu.h / FWPM_LAYER_*).
#[allow(dead_code)]
pub mod layer {
    pub const ALE_AUTH_CONNECT_V4: u16 = 55;
    pub const ALE_AUTH_CONNECT_V6: u16 = 56;
    pub const ALE_RESOURCE_ASSIGNMENT_V4: u16 = 57;
    pub const ALE_RESOURCE_ASSIGNMENT_V6: u16 = 58;
    pub const ALE_AUTH_RECV_ACCEPT_V4: u16 = 44;
    pub const ALE_AUTH_RECV_ACCEPT_V6: u16 = 45;
}

/// All 12 filter specifications for the Synergy sandbox WFP provider.
///
/// Covers:
///   - ICMPv4/v6 outbound (ALE connect + resource assignment)
///   - DNS resolution (UDP+TCP 53, IPv4+IPv6)
///   - DNS over TLS (TCP 853, IPv4+IPv6)
///   - SMB file sharing (TCP 139+445)
pub static FILTER_SPECS: &[FilterSpec] = &[
    // --- ICMPv4 ---
    FilterSpec {
        key: "10000000-0001-0001-0001-000000000001",
        name: "allow-icmpv4-ale-connect",
        description: "Allow ICMPv4 (ping) outbound via ALE connect layer",
        user_condition: "ip_protocol == 1 && remote_port == 0",
    },
    FilterSpec {
        key: "10000000-0001-0001-0001-000000000002",
        name: "allow-icmpv4-ale-assign",
        description: "Allow ICMPv4 resource assignment",
        user_condition: "ip_protocol == 1 && remote_port == 0",
    },
    // --- ICMPv6 ---
    FilterSpec {
        key: "10000000-0001-0001-0001-000000000003",
        name: "allow-icmpv6-ale-connect",
        description: "Allow ICMPv6 (ping6) outbound via ALE connect layer",
        user_condition: "ip_protocol == 58 && remote_port == 0",
    },
    FilterSpec {
        key: "10000000-0001-0001-0001-000000000004",
        name: "allow-icmpv6-ale-assign",
        description: "Allow ICMPv6 resource assignment",
        user_condition: "ip_protocol == 58 && remote_port == 0",
    },
    // --- DNS resolution (port 53) ---
    FilterSpec {
        key: "10000000-0002-0001-0001-000000000001",
        name: "allow-dns-udp-v4-out",
        description: "Allow DNS over UDP port 53 (IPv4) outbound",
        user_condition: "remote_port == 53 && ip_protocol == 17",
    },
    FilterSpec {
        key: "10000000-0002-0001-0001-000000000002",
        name: "allow-dns-tcp-v4-out",
        description: "Allow DNS over TCP port 53 (IPv4) outbound",
        user_condition: "remote_port == 53 && ip_protocol == 6",
    },
    FilterSpec {
        key: "10000000-0002-0001-0001-000000000003",
        name: "allow-dns-udp-v6-out",
        description: "Allow DNS over UDP port 53 (IPv6) outbound",
        user_condition: "remote_port == 53 && ip_protocol == 17",
    },
    FilterSpec {
        key: "10000000-0002-0001-0001-000000000004",
        name: "allow-dns-tcp-v6-out",
        description: "Allow DNS over TCP port 53 (IPv6) outbound",
        user_condition: "remote_port == 53 && ip_protocol == 6",
    },
    // --- DNS over TLS (port 853) ---
    FilterSpec {
        key: "10000000-0002-0002-0001-000000000001",
        name: "allow-dns-tls-v4-out",
        description: "Allow DNS over TLS port 853 (IPv4) outbound",
        user_condition: "remote_port == 853 && ip_protocol == 6",
    },
    FilterSpec {
        key: "10000000-0002-0002-0001-000000000002",
        name: "allow-dns-tls-v6-out",
        description: "Allow DNS over TLS port 853 (IPv6) outbound",
        user_condition: "remote_port == 853 && ip_protocol == 6",
    },
    // --- SMB file sharing ---
    FilterSpec {
        key: "10000000-0003-0001-0001-000000000001",
        name: "allow-smb-139-out",
        description: "Allow SMB over NetBIOS port 139 outbound",
        user_condition: "remote_port == 139 && ip_protocol == 6",
    },
    FilterSpec {
        key: "10000000-0003-0001-0001-000000000002",
        name: "allow-smb-445-out",
        description: "Allow SMB over TCP port 445 outbound",
        user_condition: "remote_port == 445 && ip_protocol == 6",
    },
];

/// Validate all filter specs meet invariants: unique keys, unique names,
/// non-empty conditions, correct count.
pub fn validate_filter_specs() -> Result<(), String> {
    let count = FILTER_SPECS.len();
    if count != 12 {
        return Err(format!("expected 12 filter specs, found {}", count));
    }

    for spec in FILTER_SPECS.iter() {
        if spec.user_condition.is_empty() {
            return Err(format!("filter '{}' has empty user_condition", spec.name));
        }
    }

    // Check unique keys
    let mut keys: Vec<&str> = FILTER_SPECS.iter().map(|s| s.key).collect();
    keys.sort_unstable();
    let unique_keys = {
        let mut u = keys.clone();
        u.dedup();
        u
    };
    if keys.len() != unique_keys.len() {
        return Err("FILTER_SPECS contains duplicate keys".into());
    }

    // Check unique names
    let mut names: Vec<&str> = FILTER_SPECS.iter().map(|s| s.name).collect();
    names.sort_unstable();
    let unique_names = {
        let mut u = names.clone();
        u.dedup();
        u
    };
    if names.len() != unique_names.len() {
        return Err("FILTER_SPECS contains duplicate names".into());
    }

    Ok(())
}

// ================================================================
// Tests: filter specification contracts
// ================================================================
#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    #[test]
    fn filter_keys_are_unique() {
        let keys: Vec<&str> = FILTER_SPECS.iter().map(|s| s.key).collect();
        let mut unique = keys.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(
            keys.len(),
            unique.len(),
            "All {} filter keys must be distinct, found {} unique",
            keys.len(),
            unique.len()
        );
    }

    #[test]
    fn filter_names_are_unique() {
        let names: Vec<&str> = FILTER_SPECS.iter().map(|s| s.name).collect();
        let mut unique = names.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(
            names.len(),
            unique.len(),
            "All {} filter names must be distinct, found {} unique",
            names.len(),
            unique.len()
        );
    }

    #[test]
    fn filter_keys_do_not_collide_with_provider_or_sublayer() {
        let provider_key = crate::wfp::PROVIDER_KEY;
        let sublayer_key = crate::wfp::SUBLAYER_KEY;
        for spec in FILTER_SPECS.iter() {
            assert_ne!(
                spec.key, provider_key,
                "Filter '{}' key must not collide with PROVIDER_KEY",
                spec.name
            );
            assert_ne!(
                spec.key, sublayer_key,
                "Filter '{}' key must not collide with SUBLAYER_KEY",
                spec.name
            );
        }
    }

    #[test]
    fn every_filter_has_user_condition() {
        for spec in FILTER_SPECS.iter() {
            assert!(
                !spec.user_condition.is_empty(),
                "Filter '{}' must have a non-empty user_condition",
                spec.name
            );
        }
    }

    #[test]
    fn filter_count_matches_expected() {
        assert_eq!(
            FILTER_SPECS.len(),
            12,
            "FILTER_SPECS must contain exactly 12 filter entries, got {}",
            FILTER_SPECS.len()
        );
    }

    #[test]
    fn validate_filter_specs_passes() {
        let result = validate_filter_specs();
        assert!(
            result.is_ok(),
            "validate_filter_specs must return Ok: {}",
            result.unwrap_err()
        );
    }

    #[test]
    fn filter_keys_are_valid_uuids() {
        for spec in FILTER_SPECS.iter() {
            assert_eq!(
                spec.key.len(),
                36,
                "Filter '{}' key must be 36 characters",
                spec.name
            );
            assert_eq!(
                spec.key.chars().nth(8),
                Some('-'),
                "Filter '{}' key missing hyphen at position 8",
                spec.name
            );
            assert_eq!(
                spec.key.chars().nth(13),
                Some('-'),
                "Filter '{}' key missing hyphen at position 13",
                spec.name
            );
            assert_eq!(
                spec.key.chars().nth(18),
                Some('-'),
                "Filter '{}' key missing hyphen at position 18",
                spec.name
            );
            assert_eq!(
                spec.key.chars().nth(23),
                Some('-'),
                "Filter '{}' key missing hyphen at position 23",
                spec.name
            );
        }
    }
}
