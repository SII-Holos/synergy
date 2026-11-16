# Decision Record: Forward fixed HTTP business connections through finite capabilities

Status: implemented

## Problem

Organization resource selections can contain business connections, but the gateway previously issued only model capabilities. A selected fixed HTTP connection therefore could not perform its configured operation, while forwarding caller-selected URLs or credentials would create a control-plane proxy.

## Decision

The gateway protocol has a connection capability variant for `fixed-http`, `mcp-http`, and `mcp-sse`. Model permits retain their model identity; connection permits carry only the selected resource, finite request/response limits, timeout and signed target. `orgGateway.reserve` issues the variant that matches the immutable resource configuration, and the durable call receipt retains the same target identity.

The fixed HTTP adapter accepts a bounded JSON request at the machine-only gateway route, verifies the signed capability and current grant, and forwards only to the stored endpoint and method. It constructs upstream credentials from the private resource secret, rejects browser credentials, query or content-encoding routing, redirects and unsupported response types, and strips upstream private headers. Response streams keep the call reserved until completion or cancellation; an interrupted or rejected upstream call remains an `unknown` receipt.

MCP capability variants are part of the versioned contract so their adapter can use the same authorization and receipt identity, but they are not dispatched by the fixed HTTP adapter.

## Alternatives considered

**Expose the configured endpoint to the Runtime.** This would leak routing and credential ownership into member workers and allow a caller to select another target, so it was rejected.

**Reuse the model permit for every protocol.** A model ID is not meaningful for a business operation and would invite ambiguous validation, so connection permits are a separate discriminated variant.

**Run business operations inside the organization service without a capability.** This would remove the Runtime root, binding and call receipt from the operation and make cancellation, drainage and attribution inconsistent with model calls, so it was rejected.

## Consequences

Fixed HTTP connections can be selected in a Session resource contract and invoked with the same finite grant and call accounting as models, while the service remains the only holder of endpoint and credential data. The Runtime still needs a connection tool adapter to consume the new route, and MCP HTTP/SSE requires a later protocol-specific dispatcher; configuration alone does not make those variants executable.
