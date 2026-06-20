use std::collections::HashMap;

use serde::{Deserialize, Serialize};

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
}
