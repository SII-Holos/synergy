use serde::{Deserialize, Serialize};

/// A single proxy route entry — maps an internal proxy URL to an upstream target.
///
/// The proxy sidecar intercepts sandboxed-process HTTP requests and forwards
/// them through an allow-list of pre-approved upstream targets.
///
/// Phase 2 stub: the struct exists for serde-driven planning; the route planner
/// is a no-op and real proxy sidecar management lands in Phase 3/4.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRouteSpec {
    /// Internal listen address (e.g. `http://localhost:18080/proxy/abc123`).
    pub internal: String,
    /// Upstream target URL.
    pub upstream: String,
    /// Optional header rewrites.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub headers: Vec<ProxyHeaderEntry>,
}

/// A single header rewrite rule for a proxy route.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyHeaderEntry {
    /// Header name to set on the upstream request.
    pub name: String,
    /// Header value (may be a static string or a template placeholder).
    pub value: String,
}

/// Plan a set of proxy routes from the current permission profile.
///
/// Phase 2 no-op stub: always returns an empty plan. The real planner will
/// generate `ProxyRouteSpec` entries based on approved outbound URLs and
/// network policy mode.
pub fn plan_proxy_routes() -> Result<Vec<ProxyRouteSpec>, crate::error::HelperError> {
    Ok(Vec::new())
}
