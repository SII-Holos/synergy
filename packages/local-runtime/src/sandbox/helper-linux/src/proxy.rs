use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::io::{Read, Write};
#[cfg(target_os = "linux")]
use std::net::{TcpListener, TcpStream};
#[cfg(target_os = "linux")]
use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(target_os = "linux")]
use std::thread;
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

/// Plan a full proxy bridge setup from a set of proxy routes and unix socket rules.
///
/// Generates a host-side Unix domain socket path (with a time-based suffix
/// for uniqueness), a sandbox listen address, environment variable overrides,
/// and carries unix socket allow/deny rules so the sandbox netns can enforce them.
pub fn plan_proxy_bridge(
    routes: &[ProxyRouteSpec],
    unix_socket_rules: &[UnixSocketRule],
) -> Result<ProxyBridgePlan, crate::error::HelperError> {
    if routes.is_empty() && unix_socket_rules.is_empty() {
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
            unix_socket_rules: unix_socket_rules.to_vec(),
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
    let sandbox_listen_addr = if routes.is_empty() {
        String::new()
    } else {
        "127.0.0.1:8080".to_string()
    };

    // Build environment variable overrides from the route keys.
    let mut env_overrides: Vec<(String, String)> = Vec::new();
    for _route in routes {
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
        unix_socket_rules: unix_socket_rules.to_vec(),
        allow_local_binding: false,
    })
}

// ---------------------------------------------------------------------------
// Real Linux proxy bridge runtime
// ---------------------------------------------------------------------------

/// Create a host-side Unix domain socket bridge that forwards connections
/// from the sandbox netns TCP listener (via UDS) to upstream proxies.
///
/// Composed of two parts:
/// 1. A Unix domain socket listener on the host that accepts connections
///    tunnelled from inside the sandbox netns.
/// 2. For each accepted connection, a forwarder thread reads the original
///    destination and relayed payload, opens a TCP connection to the
///    upstream proxy, and bidirectionally copies data.
#[cfg(target_os = "linux")]
pub fn create_host_bridge(
    routes: &[ProxyRouteSpec],
    socket_path: &str,
) -> Result<(), crate::error::HelperError> {
    if routes.is_empty() {
        return Err(crate::error::HelperError::Proxy(
            "create_host_bridge requires at least one route".into(),
        ));
    }

    // Remove any stale socket left by a previous run.
    let _ = std::fs::remove_file(socket_path);

    let listener = UnixListener::bind(socket_path).map_err(|e| {
        crate::error::HelperError::Proxy(format!(
            "failed to bind host bridge UDS at {socket_path}: {e}"
        ))
    })?;

    // Build a route lookup: the sandbox-side TCP listener port maps to the
    // upstream proxy endpoint.
    let route_map: HashMap<u16, String> = routes
        .iter()
        .filter_map(|r| {
            let port = extract_port(&r.internal)?;
            Some((port, r.upstream.clone()))
        })
        .collect();

    log::info!(
        "proxy bridge listening on {socket_path} with {} route(s)",
        route_map.len()
    );

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let map = route_map.clone();
                thread::spawn(move || {
                    if let Err(e) = forward_uds_to_upstream(stream, &map) {
                        log::warn!("proxy bridge forward error: {e}");
                    }
                });
            }
            Err(e) => {
                log::error!("proxy bridge accept error: {e}");
                break;
            }
        }
    }

    Ok(())
}

/// Activate the proxy inside a network namespace.
///
/// Opens a TCP listener on `sandbox_listen_addr` inside the netns and, for
/// each accepted connection, tunnels the stream to the host-side UDS bridge.
/// The first few bytes of each tunneled connection encode the destination
/// port so the host side can route to the correct upstream proxy.
#[cfg(target_os = "linux")]
pub fn activate_proxy_in_netns(plan: &ProxyBridgePlan) -> Result<(), crate::error::HelperError> {
    if plan.routes.is_empty() {
        return Ok(());
    }

    let listen_addr = &plan.sandbox_listen_addr;
    let socket_path = plan.host_bridge_socket.clone();

    let listener = TcpListener::bind(listen_addr).map_err(|e| {
        crate::error::HelperError::Proxy(format!(
            "failed to bind sandbox TCP listener on {listen_addr}: {e}"
        ))
    })?;

    log::info!("proxy activated in netns: listening on {listen_addr}, bridge at {socket_path}");

    for stream in listener.incoming() {
        match stream {
            Ok(sandbox_stream) => {
                let path = socket_path.clone();
                thread::spawn(move || {
                    if let Err(e) = tunnel_tcp_to_uds(sandbox_stream, &path) {
                        log::warn!("proxy tunnel error: {e}");
                    }
                });
            }
            Err(e) => {
                log::error!("sandbox proxy accept error: {e}");
                break;
            }
        }
    }

    Ok(())
}

/// Rewrite proxy environment variables to point at the sandbox-side TCP
/// listener. Returns overrides ready to merge into the child process
/// environment.
#[cfg(target_os = "linux")]
pub fn proxy_env_overrides(
    routes: &[ProxyRouteSpec],
    sandbox_listen_addr: &str,
) -> Vec<(String, String)> {
    let proxy_url = format!("http://{sandbox_listen_addr}");
    let mut overrides: Vec<(String, String)> = Vec::new();
    for route in routes {
        // Determine the env key from the route's internal URL's port or
        // fall back to the known set.
        let keys = match extract_port(&route.internal) {
            Some(_) => {
                // Route has a port — override all known proxy vars.
                vec![
                    "HTTP_PROXY",
                    "HTTPS_PROXY",
                    "http_proxy",
                    "https_proxy",
                    "ALL_PROXY",
                    "all_proxy",
                ]
            }
            None => vec!["HTTP_PROXY", "http_proxy"],
        };
        for key in keys {
            overrides.push((key.to_string(), proxy_url.clone()));
        }
    }
    overrides.sort();
    overrides.dedup();
    overrides
}

/// Extract a TCP port from an endpoint string like "http://127.0.0.1:8080"
/// or "127.0.0.1:3128".
#[cfg(target_os = "linux")]
fn extract_port(endpoint: &str) -> Option<u16> {
    let host_port = endpoint
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(endpoint);
    // Strip any path component.
    let host_port = host_port.split('/').next().unwrap_or(host_port);
    host_port
        .split(':')
        .last()
        .and_then(|p| p.parse::<u16>().ok())
}

/// Forward a Unix domain socket stream to the correct upstream TCP proxy.
#[cfg(target_os = "linux")]
fn forward_uds_to_upstream(
    mut uds_stream: UnixStream,
    route_map: &HashMap<u16, String>,
) -> Result<(), crate::error::HelperError> {
    // Read the 2-byte port prefix that the sandbox side prepends.
    let mut port_buf = [0u8; 2];
    uds_stream.read_exact(&mut port_buf).map_err(|e| {
        crate::error::HelperError::Proxy(format!("failed to read port prefix: {e}"))
    })?;
    let target_port = u16::from_be_bytes(port_buf);

    let upstream = route_map.get(&target_port).ok_or_else(|| {
        crate::error::HelperError::Proxy(format!("no route for sandbox port {target_port}"))
    })?;

    let mut upstream_stream = TcpStream::connect(upstream).map_err(|e| {
        crate::error::HelperError::Proxy(format!("failed to connect to upstream {upstream}: {e}"))
    })?;

    // Bidirectional copy between the UDS stream and the upstream TCP stream.
    let mut uds_read = uds_stream.try_clone().map_err(|e| {
        crate::error::HelperError::Proxy(format!("failed to clone UDS stream: {e}"))
    })?;
    let mut upstream_read = upstream_stream.try_clone().map_err(|e| {
        crate::error::HelperError::Proxy(format!("failed to clone upstream stream: {e}"))
    })?;

    let t1 = thread::spawn(move || {
        let _ = std::io::copy(&mut uds_read, &mut upstream_stream);
    });
    let t2 = thread::spawn(move || {
        let _ = std::io::copy(&mut upstream_read, &mut uds_stream);
    });

    let _ = t1.join();
    let _ = t2.join();

    Ok(())
}

/// Tunnel a sandbox-side TCP stream to the host-side UDS bridge, prepending
/// a 2-byte destination port prefix so the host side can route correctly.
#[cfg(target_os = "linux")]
fn tunnel_tcp_to_uds(
    mut tcp_stream: TcpStream,
    socket_path: &str,
) -> Result<(), crate::error::HelperError> {
    let local_port = tcp_stream.local_addr().map(|a| a.port()).unwrap_or(8080);

    let mut uds_stream = UnixStream::connect(socket_path).map_err(|e| {
        crate::error::HelperError::Proxy(format!(
            "failed to connect sandbox side to host UDS {socket_path}: {e}"
        ))
    })?;

    // Prepend the destination port so the host bridge can route.
    uds_stream
        .write_all(&local_port.to_be_bytes())
        .map_err(|e| {
            crate::error::HelperError::Proxy(format!("failed to write port prefix to UDS: {e}"))
        })?;

    // Bidirectional copy.
    let mut tcp_read = tcp_stream.try_clone().map_err(|e| {
        crate::error::HelperError::Proxy(format!("failed to clone TCP stream: {e}"))
    })?;
    let mut uds_read = uds_stream.try_clone().map_err(|e| {
        crate::error::HelperError::Proxy(format!("failed to clone UDS stream: {e}"))
    })?;

    let t1 = thread::spawn(move || {
        let _ = std::io::copy(&mut tcp_read, &mut uds_stream);
    });
    let t2 = thread::spawn(move || {
        let _ = std::io::copy(&mut uds_read, &mut tcp_stream);
    });

    let _ = t1.join();
    let _ = t2.join();

    Ok(())
}

// ---------------------------------------------------------------------------
// macOS / non-Linux no-op stubs for the bridge functions
// ---------------------------------------------------------------------------

/// No-op on non-Linux: real bridge requires Linux UDS + netns features.
#[cfg(not(target_os = "linux"))]
pub fn create_host_bridge(
    _routes: &[ProxyRouteSpec],
    _socket_path: &str,
) -> Result<(), crate::error::HelperError> {
    Err(crate::error::HelperError::Proxy(
        "create_host_bridge is only supported on Linux".into(),
    ))
}

/// No-op on non-Linux: real netns proxy requires Linux namespace support.
/// Empty routes return Ok(()) to match the Linux behavior contract.
#[cfg(not(target_os = "linux"))]
pub fn activate_proxy_in_netns(plan: &ProxyBridgePlan) -> Result<(), crate::error::HelperError> {
    if plan.routes.is_empty() {
        return Ok(());
    }
    Err(crate::error::HelperError::Proxy(
        "activate_proxy_in_netns is only supported on Linux".into(),
    ))
}

/// No-op on non-Linux: returns empty vec.
#[cfg(not(target_os = "linux"))]
pub fn proxy_env_overrides(
    _routes: &[ProxyRouteSpec],
    _sandbox_listen_addr: &str,
) -> Vec<(String, String)> {
    Vec::new()
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
        let plan = plan_proxy_bridge(&routes, &[]).unwrap();
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
        let plan1 = plan_proxy_bridge(&[route.clone()], &[]).unwrap();
        let plan2 = plan_proxy_bridge(&[route], &[]).unwrap();
        assert_ne!(plan1.host_bridge_socket, plan2.host_bridge_socket);
    }

    #[test]
    fn env_overrides_include_proxy_keys() {
        let routes = vec![ProxyRouteSpec {
            internal: "http://127.0.0.1:3128".to_string(),
            upstream: "http://127.0.0.1:3128".to_string(),
            headers: Vec::new(),
        }];
        let plan = plan_proxy_bridge(&routes, &[]).unwrap();
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
        let plan = plan_proxy_bridge(&[], &[]).unwrap();
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
        let plan = plan_proxy_bridge(&[], &[]).unwrap();
        assert!(plan.domain_rules.is_empty());
        assert!(!plan.socks5.enabled);
        assert!(plan.socks5.url.is_none());
        assert!(!plan.socks5.udp_enabled);
        assert!(plan.unix_socket_rules.is_empty());
        assert!(!plan.allow_local_binding);
    }

    // --- Bridge runtime contract tests ---

    #[test]
    fn proxy_route_spec_validates_fields() {
        let spec = ProxyRouteSpec {
            internal: "http://127.0.0.1:8081".to_string(),
            upstream: "http://127.0.0.1:4040".to_string(),
            headers: vec![],
        };
        assert_eq!(spec.internal, "http://127.0.0.1:8081");
        assert_eq!(spec.upstream, "http://127.0.0.1:4040");
        assert!(spec.headers.is_empty());
    }

    #[test]
    fn proxy_route_spec_headers_can_be_set() {
        let spec = ProxyRouteSpec {
            internal: "http://127.0.0.1:3128".to_string(),
            upstream: "http://127.0.0.1:3128".to_string(),
            headers: vec![ProxyHeaderEntry {
                name: "X-Forwarded-For".to_string(),
                value: "sandbox".to_string(),
            }],
        };
        assert_eq!(spec.headers.len(), 1);
        assert_eq!(spec.headers[0].name, "X-Forwarded-For");
        assert_eq!(spec.headers[0].value, "sandbox");
    }

    #[test]
    fn non_linux_create_host_bridge_returns_error() {
        let routes = vec![ProxyRouteSpec {
            internal: "http://127.0.0.1:3128".to_string(),
            upstream: "http://127.0.0.1:3128".to_string(),
            headers: vec![],
        }];
        let result = create_host_bridge(&routes, "/tmp/test.sock");
        if cfg!(target_os = "linux") {
            // On Linux the real implementation blocks forever on
            // listener.incoming(), so we only verify the empty-routes
            // fast path which returns immediately.
            let empty_result = create_host_bridge(&[], "/tmp/test.sock");
            assert!(empty_result.is_err());
            assert!(empty_result.unwrap_err().to_string().contains("route"));
        } else {
            assert!(result.is_err());
            assert!(result.unwrap_err().to_string().contains("Linux"));
        }
    }

    #[test]
    fn non_linux_activate_proxy_in_netns_returns_error() {
        let empty_plan = ProxyBridgePlan {
            routes: vec![],
            host_bridge_socket: String::new(),
            sandbox_listen_addr: String::new(),
            env_overrides: vec![],
            domain_rules: vec![],
            socks5: Socks5ConfigContract {
                enabled: false,
                url: None,
                udp_enabled: false,
            },
            unix_socket_rules: vec![],
            allow_local_binding: false,
        };
        // Empty routes — returns Ok(()) on all platforms.
        assert!(activate_proxy_in_netns(&empty_plan).is_ok());

        if !cfg!(target_os = "linux") {
            let plan = ProxyBridgePlan {
                routes: vec![ProxyRouteSpec {
                    internal: "http://127.0.0.1:3130".to_string(),
                    upstream: "http://127.0.0.1:3130".to_string(),
                    headers: vec![],
                }],
                host_bridge_socket: "/tmp/test.sock".to_string(),
                sandbox_listen_addr: "127.0.0.1:8080".to_string(),
                env_overrides: vec![],
                domain_rules: vec![],
                socks5: Socks5ConfigContract {
                    enabled: false,
                    url: None,
                    udp_enabled: false,
                },
                unix_socket_rules: vec![],
                allow_local_binding: false,
            };
            let result = activate_proxy_in_netns(&plan);
            assert!(result.is_err());
            assert!(result.unwrap_err().to_string().contains("Linux"));
        }
    }

    #[test]
    fn non_linux_proxy_env_overrides_is_empty_for_no_routes() {
        let overrides = proxy_env_overrides(&[], "127.0.0.1:8080");
        assert!(overrides.is_empty());
    }

    #[test]
    fn plan_proxy_bridge_env_overrides_map_to_localhost() {
        let routes = vec![ProxyRouteSpec {
            internal: "http://127.0.0.1:4444".to_string(),
            upstream: "http://127.0.0.1:4444".to_string(),
            headers: vec![],
        }];
        let plan = plan_proxy_bridge(&routes, &[]).unwrap();
        for (_, value) in &plan.env_overrides {
            assert!(
                value.starts_with("http://"),
                "env override value should be an HTTP URL"
            );
            assert!(
                value.contains("127.0.0.1"),
                "env override should target localhost"
            );
        }
    }

    #[test]
    fn plan_proxy_bridge_env_overrides_are_deduplicated() {
        let routes = vec![
            ProxyRouteSpec {
                internal: "http://127.0.0.1:3128".to_string(),
                upstream: "http://127.0.0.1:3128".to_string(),
                headers: vec![],
            },
            ProxyRouteSpec {
                internal: "http://127.0.0.1:8888".to_string(),
                upstream: "http://127.0.0.1:8888".to_string(),
                headers: vec![],
            },
        ];
        let plan = plan_proxy_bridge(&routes, &[]).unwrap();
        for (key, _) in &plan.env_overrides {
            let count = plan.env_overrides.iter().filter(|(k, _)| k == key).count();
            assert_eq!(count, 1, "env key '{key}' should appear only once");
        }
    }

    #[test]
    fn plan_proxy_bridge_sandbox_listen_addr_is_consistent() {
        let routes = vec![ProxyRouteSpec {
            internal: "http://127.0.0.1:3128".to_string(),
            upstream: "http://127.0.0.1:3128".to_string(),
            headers: vec![],
        }];
        let plan = plan_proxy_bridge(&routes, &[]).unwrap();
        // Verify that all env overrides encode the same listen address.
        let expected = format!("http://{}", plan.sandbox_listen_addr);
        for (key, value) in &plan.env_overrides {
            assert_eq!(
                value, &expected,
                "env key {key} should point to sandbox listen addr"
            );
        }
    }

    #[test]
    fn plan_proxy_bridge_passes_unix_socket_rules_through() {
        let routes = vec![ProxyRouteSpec {
            internal: "http://127.0.0.1:3128".to_string(),
            upstream: "http://127.0.0.1:3128".to_string(),
            headers: vec![],
        }];
        let rules = vec![UnixSocketRule {
            path: "/var/run/docker.sock".to_string(),
            permission: DomainPermission::Allow,
        }];
        let plan = plan_proxy_bridge(&routes, &rules).unwrap();
        assert_eq!(plan.unix_socket_rules.len(), 1);
        assert_eq!(plan.unix_socket_rules[0].path, "/var/run/docker.sock");
        assert_eq!(
            plan.unix_socket_rules[0].permission,
            DomainPermission::Allow
        );
    }

    #[test]
    fn plan_proxy_bridge_with_only_unix_socket_rules_produces_plan() {
        let rules = vec![UnixSocketRule {
            path: "/tmp/agent.sock".to_string(),
            permission: DomainPermission::Allow,
        }];
        let plan = plan_proxy_bridge(&[], &rules).unwrap();
        assert!(plan.routes.is_empty());
        assert_eq!(plan.unix_socket_rules.len(), 1);
        assert_eq!(plan.unix_socket_rules[0].path, "/tmp/agent.sock");
    }
}
