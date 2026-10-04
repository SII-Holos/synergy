# Decision Record: Bound the embedded Host extension surface

Status: implemented

## Problem

Embedding adds useful Host interfaces, but an unregistered output-storage provider increases compatibility surface without a consumer. Explicit runtime component selection also needs installed fixtures that select their actual native dependencies rather than relying on product defaults.

## Decision

Remove the unused ToolOutputSource provider; truncation retains its existing native artifact owner. Retain AgentCall structured output: embedded schema-bound generation and target classification use its forced output tool and validated tool-call result. It is separate from a policy that forces user-facing replies into tools. Configuration, catalog, request authorization, Session execution admission, tool policy, durable event sinks and workspace boundaries remain independent, registered Runtime interfaces with concrete consumers and behavior tests.

Installed native-process fixtures explicitly select Local Runtime. Optional product configuration is present only when its owning component is selected. Wake-retry tests use persisted Sessions and the actual interrupted-turn settlement entry, preserving admission before model execution.

## Alternatives considered

**Keep speculative extension ports.** This increases test and compatibility obligations without a current use.

**Restore implicit product registration.** This hides dependency selection and imports excluded product owners into embedded runtimes.

## Consequences

Hosts have fewer interfaces to maintain. A different artifact destination requires a concrete consumer and its boundary tests. Structured output remains covered by the AgentCall tool-result boundary and embedding consumers. Core and full published configuration schemas are regenerated from the same owner registrations as their build artifacts.

## Links

- [Host configuration ownership](2026-10-01-host-configuration-and-output-sources.md)
- [Agent Runtime](../../../../packages/agent-runtime/README.md)
