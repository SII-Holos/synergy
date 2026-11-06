# Decision Record: Explicit managed runtime SDK

Status: implemented

## Problem

The SDK invoked a retired server command, inferred readiness from terminal text, and could leave its child alive after startup failure. Optional component APIs were indistinguishable from a complete runtime, and adding Scope headers could discard a caller's Headers credentials.

## Decision

Node.js uses an explicitly selected executable, exact host/component versions and data home. Managed runtimes bind to loopback with a fresh bearer credential passed through the child environment. CLI publishes the versioned SDK readiness record after runtime initialization and shutdown ownership are ready. The SDK verifies process identity, version, data home, endpoint and selected components before returning. Failed startup and abort drain the owned process; attaching never grants process ownership.

Harness records component selection per Runtime. Server exposes the active selection through the global capabilities API, and the generated SDK retains the complete API surface. Header composition uses the generated client's merge helper so Scope selection preserves credentials and custom headers. Custom fetch remains supported.

Web startup shares one capabilities request. Eager Holos, Channels, MCP and Agenda reads wait for discovery; optional navigation, settings, composer controls and workbench registrations use the active selection. Reconnection discards stale discovery results and clears removed component state. A missing discovery contract is an initialization error, rather than an assumption that every component is installed.

## Alternatives considered

**Parse a human startup banner.** Presentation changes and translated output cannot provide a stable process protocol.

**Find any executable on PATH or reuse an existing port.** That obscures host version, installation generation and process ownership.

**Port the Harness into Node.js.** Native execution and storage use Bun; a managed HTTP process preserves the existing ownership boundary.

## Consequences

Managed startup options are explicit and versioned. Existing-service clients can continue to use `createSynergyClient`, or use attach mode for a health-checked connection. Protocol tests cover partial output, identity/version failure, timeout, cancellation, auth and cleanup. A real source runtime verifies authenticated SDK requests and releasing the home for reopening; built SDK verification also runs from Node.js.
