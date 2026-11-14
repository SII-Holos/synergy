# Decision Record: Forward organization MCP connections through a protocol adapter

Status: implemented

## Problem

Organization resources already described remote MCP HTTP and SSE protocols, but the gateway could only dispatch fixed HTTP connections. Leaving those capabilities disconnected would force a member to hold upstream credentials or invent an unbounded URL proxy.

## Decision

The organization service owns the MCP adapter and keeps the existing signed connection capability, durable call receipt, byte limits and current authority checks. The protocol package defines strict `list-tools` and `call-tool` operation DTOs. A dedicated gateway route creates a fresh official MCP SDK client for each operation, uses Streamable HTTP or legacy SSE according to the admitted resource protocol, injects only the service-owned credential, pins requests to the configured endpoint origin, rejects redirects, closes the client after the operation and returns bounded JSON results.

The verified member resource client validates the service capability and connection identity before sending the operation to the service route. The resident Runtime exposes one `organization_mcp` tool that accepts a selected resource ID, lists remote tools or calls a named tool, and returns a bounded result without endpoint or credential data. Every operation binds to the canonical accepted Session root through the existing execution resolution path and receives a new call ID.

## Alternatives considered

**Member-side MCP clients** would require forwarding service credentials or adding a second credential exchange to the Runtime, so they lost the server-owned secret boundary.

**A generic URL or JSON-RPC proxy** would let callers select transport destinations and protocol details outside the resource contract, so it lost the fixed endpoint and capability guarantees.

**Hand-rolled MCP framing** would duplicate transport, initialization, SSE and result validation behavior already maintained by the official SDK, so it lost interoperability and increased protocol drift risk.

## Consequences

MCP HTTP and SSE business resources are usable through the same finite, auditable gateway as models and fixed HTTP connections. Each operation creates a new upstream MCP session, which keeps lifetime and shutdown ownership simple but does not preserve remote session state between operations. Tool discovery is explicit through `list-tools`; remote definitions are not installed as local resident tools or treated as new authority. The organization service now depends directly on the official MCP SDK, and the generated organization API includes the MCP route and strict operation/result schemas.
