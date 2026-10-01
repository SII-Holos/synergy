# Decision Record: Admit embedded tools before acquiring resources

Status: implemented

## Problem

An embedded host owns Invocation and business authorization. A generic Session permission alone cannot grant that authority, and checking inside a tool executor occurs after execution resources can be acquired.

## Decision

Register an optional Runtime-scoped ToolPolicySource before composition seals. Selection receives detached candidate identities and can only narrow visible and deferred tools. Execution authorization receives the exact persisted assistant and tool-call identity and detached JSON input, before resource acquisition or tool dispatch. Source errors deny the call without exposing arbitrary source messages; cancellation retains its original reason. Generic permission, ControlProfile, sandbox and execution implementations retain ownership of their existing decisions. Cortex exposes its complete tool suite through its owning public entry for explicit host registration.

## Alternatives considered

**Executor-only checks.** They cannot stop allocation and do not consistently cover tool sources.

**Host copies of the resolver.** They duplicate policy and lifecycle algorithms and make upstream changes difficult to absorb.

## Consequences

Manual discovery and deferred expansion apply the same host selection as model-visible resolution. A registered host selection requires a concrete Session and model for discovery; missing context fails closed. This selection affects visibility and activation candidates, while execution authorization still runs before resources and dispatch.

Hosts can bind tool use to their own durable authority without exporting resolver or processor implementations. An absent source preserves default product behavior. The host's policy applies to diagnostic, native, ephemeral and MCP calls at the same final dispatch boundary.
