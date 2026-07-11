# Agent Client Protocol

`synergy acp` exposes the current Synergy runtime as an Agent Client Protocol v1 agent over NDJSON stdio. Product context and the distinction from outbound external-agent adapters are documented in [Agents, tools, skills, and commands](../../../../docs/product/agents-and-tools.md).

## Ownership

- `cli/cmd/acp.ts` runs migrations, starts a local Synergy HTTP server, creates a generated SDK client for the requested working directory, and binds ACP stdio transport.
- `agent.ts` implements protocol initialization, modes/models, session prompting, cancellation, permission bridging, history replay, and event-to-ACP updates.
- `session.ts` maps ACP session state to durable Synergy session IDs and retains the ACP working directory, MCP descriptors, selected model, and mode.
- `types.ts` defines the internal ACP configuration and session state.

## Session Model

`session/new` creates a normal Synergy session in the supplied `cwd`, using the effective control profile and current default model. `session/load` loads that durable session and replays visible user/assistant messages, tool calls/results, reasoning/text, and plan state to the ACP client.

Prompts enter the ordinary Synergy session loop. Live `message.part.updated` events become ACP agent-message, thought, tool-call, diff, and plan updates. Permission requests are presented to the ACP client as allow-once or reject; a failed or unsupported permission interaction is rejected in Synergy.

ACP cancellation aborts the mapped session turn. Model and mode changes update ACP session state and route later prompts through the selected Synergy model/agent contract.

## Capabilities and Limits

Initialization advertises:

- session loading
- HTTP and SSE MCP descriptors
- embedded context and images
- Synergy model and mode catalogs
- terminal-auth metadata when the client supports it

The advertised login path is `synergy auth login`. The ACP `authenticate` method itself is not implemented. ACP-supplied MCP descriptors are retained in ACP session state; they do not create a separate global MCP configuration.

## Run and Verify

```bash
synergy acp --cwd /absolute/project/path
```

Use an ACP client or protocol fixture to exercise initialization, session creation/load, streaming parts, tools, permission replies, model/mode selection, and cancellation. Run relevant tests from `packages/synergy`; do not test by restarting the active Synergy instance.
