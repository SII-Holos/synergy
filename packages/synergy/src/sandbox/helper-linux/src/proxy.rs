use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

/// A single proxy route entry — maps a sandbox-visible proxy URL to the
/// approved host-side loopback proxy endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRouteSpec {
    /// Internal listen address inside the sandbox namespace.
    pub internal: String,
    /// Host-side upstream proxy URL.
    pub upstream: String,
    /// Optional header rewrites.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub headers: Vec<ProxyHeaderEntry>,
}

/// A single header rewrite rule for a proxy route.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyHeaderEntry {
    pub name: String,
    pub value: String,
}

/// Permission decision for a domain or unix socket rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DomainPermission {
    Allow,
    Deny,
}

/// A per-domain routing rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainRule {
    pub pattern: String,
    pub permission: DomainPermission,
}

/// SOCKS5 proxy configuration contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Socks5ConfigContract {
    pub enabled: bool,
    pub url: Option<String>,
    pub udp_enabled: bool,
}

/// Rule for allowing or denying access to a Unix domain socket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnixSocketRule {
    pub path: String,
    pub permission: DomainPermission,
}

/// Full proxy bridge setup plan: routes, UDS socket path, sandbox listen
/// address, and environment variable overrides.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyBridgePlan {
    /// Proxy routes to activate inside the sandbox namespace.
    pub routes: Vec<ProxyRouteSpec>,
    /// Path to the host-side Unix domain socket for the proxy bridge.
    pub host_bridge_socket: String,
    /// Listen address inside the sandbox netns (e.g. "127.0.0.1:8080").
    pub sandbox_listen_addr: String,
    /// Environment variable overrides to set inside the sandbox
    /// (e.g. "HTTP_PROXY" → "http://127.0.0.1:8080").
    pub env_overrides: Vec<(String, String)>,
    /// Per-domain allow/deny rules.
    pub domain_rules: Vec<DomainRule>,
    /// SOCKS5 proxy configuration.
    pub socks5: Socks5ConfigContract,
    /// Unix domain socket access rules.
    pub unix_socket_rules: Vec<UnixSocketRule>,
    /// Whether local port binding is allowed inside the sandbox.
    pub allow_local_binding: bool,
}

const PROXY_ENV_KEYS: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "npm_config_proxy",
    "npm_config_https_proxy",
];

/// Collect loopback proxy environment variables into route specifications.
pub fn collect_proxy_env() -> Result<HashMap<String, ProxyRouteSpec>, crate::error::HelperError> {
    collect_proxy_env_from(std::env::vars())
}

pub fn collect_proxy_env_from<I>(
    vars: I,
) -> Result<HashMap<String, ProxyRouteSpec>, crate::error::HelperError>
where
    I: IntoIterator<Item = (String, String)>,
{
    let mut routes = HashMap::new();
    for (key, value) in vars {
        if !PROXY_ENV_KEYS.contains(&key.as_str()) || value.trim().is_empty() {
            continue;
        }
        if !is_loopback_endpoint(&value) {
            continue;
        }
        routes.insert(
            key,
            ProxyRouteSpec {
                internal: value.clone(),
                upstream: value,
                headers: Vec::new(),
            },
        );
    }
    Ok(routes)
}

/// Check whether a URL or host:port string represents a loopback endpoint.
pub fn is_loopback_endpoint(endpoint: &str) -> bool {
    let host = extract_host(endpoint)
        .unwrap_or(endpoint)
        .trim_matches(|c| c == '[' || c == ']');
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

fn extract_host(endpoint: &str) -> Option<&str> {
    let without_scheme = endpoint
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(endpoint);
    if let Some(rest) = without_scheme.strip_prefix('[') {
        return rest.split_once(']').map(|(host, _)| host);
    }
    let authority = without_scheme.split('/').next().unwrap_or(without_scheme);
    Some(
        authority
            .split('@')
            .next_back()
            .unwrap_or(authority)
            .split(':')
            .next()
            .unwrap_or(authority),
    )
}

/// Plan a set of proxy routes from the current environment.
pub fn plan_proxy_routes() -> Result<Vec<ProxyRouteSpec>, crate::error::HelperError> {
    Ok(collect_proxy_env()?.into_values().collect())
}

/// Plan a full proxy bridge setup from a set of proxy routes.
///
/// Generates a host-side Unix domain socket path (with a time-based suffix
/// for uniqueness), a sandbox listen address, and environment variable
/// overrides so that sandboxed processes route through the bridge.
pub fn plan_proxy_bridge(
    routes: &[ProxyRouteSpec],
) -> Result<ProxyBridgePlan, crate::error::HelperError> {
    if routes.is_empty() {
        return Ok(ProxyBridgePlan {
            routes: Vec::new(),
            host_bridge_socket: String::new(),
            sandbox_listen_addr: String::new(),
            env_overrides: Vec::new(),
            domain_rules: Vec::new(),
            socks5: Socks5ConfigContract {
                enabled: false,
                url: None,
                udp_enabled: false,
            },
            unix_socket_rules: Vec::new(),
            allow_local_binding: false,
        });
    }

    // Generate a unique-ish suffix for the UDS path.  No `rand` crate in
    // this binary, so we use the current time in microseconds.
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros();
    let host_bridge_socket = format!("/tmp/synergy-proxy-bridge-{suffix}.sock");

    // Sandbox-side listen address — use a standard localhost port.
    // In a real deployment the port would come from config; for now we
    // assign a predictable default that the bridge process will bind to.
    let sandbox_listen_addr = "127.0.0.1:8080".to_string();

    // Build environment variable overrides from the route keys.
    let mut env_overrides: Vec<(String, String)> = Vec::new();
    for _route in routes {
        // The key is inferred from the route's internal address; in a
        // full implementation this would look at upstream too.
        let proxy_url = format!("http://{sandbox_listen_addr}");
        env_overrides.push(("HTTP_PROXY".to_string(), proxy_url.clone()));
        env_overrides.push(("HTTPS_PROXY".to_string(), proxy_url.clone()));
        env_overrides.push(("http_proxy".to_string(), proxy_url.clone()));
        env_overrides.push(("https_proxy".to_string(), proxy_url));
    }
    // Deduplicate.
    env_overrides.sort();
    env_overrides.dedup();

    Ok(ProxyBridgePlan {
        routes: routes.to_vec(),
        host_bridge_socket,
        sandbox_listen_addr,
        env_overrides,
        domain_rules: Vec::new(),
        socks5: Socks5ConfigContract {
            enabled: false,
            url: None,
            udp_enabled: false,
        },
        unix_socket_rules: Vec::new(),
        allow_local_binding: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_recognizes_127_0_0_1() {
        assert!(is_loopback_endpoint("http://127.0.0.1:8080"));
        assert!(is_loopback_endpoint("http://127.0.0.1:3128"));
    }

    #[test]
    fn loopback_recognizes_localhost() {
        assert!(is_loopback_endpoint("http://localhost:8080"));
        assert!(is_loopback_endpoint("localhost:8888"));
    }

    #[test]
    fn loopback_recognizes_ipv6_localhost() {
        assert!(is_loopback_endpoint("http://[::1]:8080"));
        assert!(is_loopback_endpoint("[::1]:3128"));
    }

    #[test]
    fn loopback_rejects_non_loopback_hosts() {
        assert!(!is_loopback_endpoint("http://192.168.1.1:8080"));
        assert!(!is_loopback_endpoint("http://proxy.corp.com:3128"));
        assert!(!is_loopback_endpoint("http://10.0.0.1:8080"));
        assert!(!is_loopback_endpoint("http://172.16.0.1:8080"));
    }

    #[test]
    fn collect_proxy_env_captures_http_proxy_loopback() {
        let result = collect_proxy_env_from(vec![(
            "HTTP_PROXY".to_string(),
            "http://127.0.0.1:8080".to_string(),
        )])
        .unwrap();
        assert!(result.contains_key("HTTP_PROXY"));
    }

    #[test]
    fn collect_proxy_env_rejects_non_loopback() {
        let result = collect_proxy_env_from(vec![(
            "HTTP_PROXY".to_string(),
            "http://10.0.0.1:8080".to_string(),
        )])
        .unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn collect_proxy_env_returns_structured_specs() {
        let result = collect_proxy_env_from(vec![(
            "HTTPS_PROXY".to_string(),
            "http://localhost:3128".to_string(),
        )])
        .unwrap();
        let spec = result.get("HTTPS_PROXY").expect("spec should exist");
        assert_eq!(spec.internal, "http://localhost:3128");
        assert_eq!(spec.upstream, "http://localhost:3128");
    }

    #[test]
    fn plan_proxy_routes_returns_vec() {
        let routes = plan_proxy_routes().unwrap();
        assert!(routes
            .iter()
            .all(|route| is_loopback_endpoint(&route.upstream)));
    }

    // --- ProxyBridgePlan / plan_proxy_bridge tests ---

    #[test]
    fn plan_proxy_bridge_produces_valid_plan() {
        let routes = vec![ProxyRouteSpec {
            internal: "http://127.0.0.1:3128".to_string(),
            upstream: "http://127.0.0.1:3128".to_string(),
            headers: Vec::new(),
        }];
        let plan = plan_proxy_bridge(&routes).unwrap();
        assert_eq!(plan.routes.len(), 1);
        assert!(!plan.host_bridge_socket.is_empty());
        assert!(plan
            .host_bridge_socket
            .starts_with("/tmp/synergy-proxy-bridge-"));
        assert!(plan.host_bridge_socket.ends_with(".sock"));
        assert_eq!(plan.sandbox_listen_addr, "127.0.0.1:8080");
        assert!(!plan.env_overrides.is_empty());
    }

    #[test]
    fn host_bridge_socket_is_unique_per_call() {
        let route = ProxyRouteSpec {
            internal: "http://127.0.0.1:8080".to_string(),
            upstream: "http://127.0.0.1:8080".to_string(),
            headers: Vec::new(),
        };
        let plan1 = plan_proxy_bridge(&[route.clone()]).unwrap();
        let plan2 = plan_proxy_bridge(&[route]).unwrap();
        assert_ne!(plan1.host_bridge_socket, plan2.host_bridge_socket);
    }

    #[test]
    fn env_overrides_include_proxy_keys() {
        let routes = vec![ProxyRouteSpec {
            internal: "http://127.0.0.1:3128".to_string(),
            upstream: "http://127.0.0.1:3128".to_string(),
            headers: Vec::new(),
        }];
        let plan = plan_proxy_bridge(&routes).unwrap();
        let keys: Vec<&str> = plan.env_overrides.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"HTTP_PROXY"));
        assert!(keys.contains(&"HTTPS_PROXY"));
        assert!(keys.contains(&"http_proxy"));
        assert!(keys.contains(&"https_proxy"));
        // Values are all the sandbox listen addr.
        let addr = format!("http://{}", plan.sandbox_listen_addr);
        for (_, v) in &plan.env_overrides {
            assert_eq!(v, &addr);
        }
    }

    #[test]
    fn empty_routes_returns_empty_plan() {
        let plan = plan_proxy_bridge(&[]).unwrap();
        assert!(plan.routes.is_empty());
        assert!(plan.host_bridge_socket.is_empty());
        assert!(plan.sandbox_listen_addr.is_empty());
        assert!(plan.env_overrides.is_empty());
    }

    // --- New contract tests ---

    #[test]
    fn domain_rules_can_be_built() {
        let rule = DomainRule {
            pattern: "api.example.com".to_string(),
            permission: DomainPermission::Allow,
        };
        assert_eq!(rule.pattern, "api.example.com");
        assert_eq!(rule.permission, DomainPermission::Allow);
    }

    #[test]
    fn domain_rule_can_deny() {
        let rule = DomainRule {
            pattern: "*.evil.com".to_string(),
            permission: DomainPermission::Deny,
        };
        assert_eq!(rule.permission, DomainPermission::Deny);
        assert_eq!(rule.pattern, "*.evil.com");
    }

    #[test]
    fn socks5_config_contract_fields_are_correct() {
        let enabled = Socks5ConfigContract {
            enabled: true,
            url: Some("socks5://127.0.0.1:9050".to_string()),
            udp_enabled: true,
        };
        assert!(enabled.enabled);
        assert_eq!(enabled.url, Some("socks5://127.0.0.1:9050".to_string()));
        assert!(enabled.udp_enabled);

        let disabled = Socks5ConfigContract {
            enabled: false,
            url: None,
            udp_enabled: false,
        };
        assert!(!disabled.enabled);
        assert_eq!(disabled.url, None);
        assert!(!disabled.udp_enabled);
    }

    #[test]
    fn unix_socket_rules_can_be_allow_or_deny() {
        let allow_rule = UnixSocketRule {
            path: "/var/run/docker.sock".to_string(),
            permission: DomainPermission::Allow,
        };
        assert_eq!(allow_rule.path, "/var/run/docker.sock");
        assert_eq!(allow_rule.permission, DomainPermission::Allow);

        let deny_rule = UnixSocketRule {
            path: "/tmp/private.sock".to_string(),
            permission: DomainPermission::Deny,
        };
        assert_eq!(deny_rule.path, "/tmp/private.sock");
        assert_eq!(deny_rule.permission, DomainPermission::Deny);
    }

    #[test]
    fn empty_plan_has_default_new_fields() {
        let plan = plan_proxy_bridge(&[]).unwrap();
        assert!(plan.domain_rules.is_empty());
        assert!(!plan.socks5.enabled);
        assert!(plan.socks5.url.is_none());
        assert!(!plan.socks5.udp_enabled);
        assert!(plan.unix_socket_rules.is_empty());
        assert!(!plan.allow_local_binding);
    }
}
