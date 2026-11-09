# Decision Record: Member fixed HTTP connection client

Status: implemented

## Problem

The organization service can issue a signed capability for a selected fixed HTTP connection, but a member Runtime still needs a transport boundary that keeps endpoint and credential ownership in the service while allowing a native caller to consume the response. Reusing the model SDK path or accepting a caller URL would widen the authority and lose response drainage evidence.

## Decision

The verified member resource client exposes one `invoke` operation for fixed HTTP connection permits. It parses and verifies the service signature against the current connection identity, checks organization, deployment, Runtime, epoch, key and validity window, and sends one POST to the organization gateway route with only the encoded capability and JSON content type. The service chooses the configured endpoint, method and credential; the member never receives those values and does not forward caller cookies, Origin or routing headers. Request bytes stay within the permit allowance.

The returned body remains attached to the client occupancy slot until EOF, cancellation or connection shutdown. A stream wrapper drains and releases the slot exactly once; close cancels readers and waits for active calls and retained bodies before closing the private TLS pool. Model permits and MCP variants are rejected before dispatch. The one-call service receipt remains the replay boundary, so a repeated capability returns the service's conflict without a second upstream request.

## Alternatives considered

**Expose the configured endpoint and credential to the Runtime.** This would move secret and routing authority into the machine process and make redaction depend on every caller. The service gateway keeps both values server-owned.

**Forward an arbitrary URL or caller headers from the native tool.** A URL/header proxy would bypass the selected resource contract and could reintroduce cookies, Origin or private routing. The client has one fixed gateway route and a fixed header allowlist.

**Read the complete response before returning it.** Buffering would hide physical drainage and keep large business responses in memory. A bounded gateway stream stays observable and releases capacity only when its reader reaches a terminal state.

## Consequences

Native Runtime code can consume selected fixed HTTP resources without a second credential path, while service receipts, byte limits, TLS verification and current authority remain authoritative. The client carries response readers across close and reconnect boundaries, so callers must consume or cancel returned bodies. MCP HTTP/SSE resources still require their protocol-specific adapter and are not dispatched by this operation.
