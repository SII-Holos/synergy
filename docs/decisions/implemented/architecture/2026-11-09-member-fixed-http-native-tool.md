# Decision Record: Member fixed HTTP native tool

Status: implemented

## Problem

Fixed HTTP resources are selected in an organization Session, but the native Agent tool catalog must expose them without turning a resource ID into an arbitrary proxy or bypassing the accepted root and execution grant. Tool execution also needs to preserve the service-owned credential boundary and a bounded response contract.

## Decision

The member composition registers one resident `organization_connection` tool. Its strict input names a selected resource ID and optional JSON body; the tool resolves the current Session through the organization binding, accepted command receipt and Cortex lineage, then obtains a binding grant and a fresh gateway call capability for that resource. It refuses resources outside the Session selection and all protocols except fixed HTTP. The service continues to choose the endpoint, method and credential, while the member resource client sends only the signed capability and bounded JSON.

The tool reads the response through the returned stream with a 4 MiB model-facing bound, cancels excess data and returns status/content-type metadata without forwarding private upstream headers. The one-call receipt and resource-client occupancy remain authoritative; the tool does not retry or expose a second transport path. Unsupported MCP resources remain reserved for a protocol-specific adapter.

## Alternatives considered

**Register one tool per endpoint or resource name.** Tool discovery has no Session-specific resource catalog and endpoint names are not stable authorization identities. A single strict tool keeps discovery static and checks the selected resource at execution time.

**Let the tool call a URL supplied in its arguments.** This would make the Runtime an arbitrary network proxy and let model input choose routing or credentials. Only the organization gateway route and signed capability are accepted.

**Reuse the model provider path for business calls.** Model SDKs impose protocol-specific request shapes and retry behavior that do not describe business side effects. The tool uses the fixed connection adapter and preserves receipt-backed one-shot semantics.

## Consequences

Selected fixed HTTP business connections can participate in a native Session with the same root, binding, epoch and drainage checks as model calls. Tool catalogs remain resident only in the member composition; personal Runtimes and unsupported connection protocols do not gain the surface. Resource IDs must be available to the caller from the selected Session contract, and MCP HTTP/SSE requires a later adapter with its own tool discovery and stream rules.
