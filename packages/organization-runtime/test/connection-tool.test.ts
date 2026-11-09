import { expect, test } from "bun:test"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionExecutionSource } from "@ericsanchezok/synergy-harness/session/execution-source"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { executionFixture as execution } from "./support/execution"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"

test("native organization connection tool invokes only the selected fixed HTTP resource", async () => {
  const received: Array<{ authorization: string | null; caller: string | null; body: unknown }> = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.push({
        authorization: request.headers.get("authorization"),
        caller: request.headers.get("x-private-caller"),
        body: await request.json(),
      })
      return Response.json({ operationID: "tool-op", accepted: true })
    },
  })
  try {
    await using f = await execution({ execution: true, connectionEndpoint: new URL("/business", upstream.url).href })
    const scope = (await f.runtime.run(() => Session.get(f.sessionID))).scope
    await f.runtime.run(() => SessionExecutionSource.authorize({ sessionID: f.sessionID, scopeID: scope.id }))
    await f.binding()
    const tool = await f.runtime.run(() =>
      ScopeContext.provide({ scope, workspace: null, fn: () => ToolRegistry.find("organization_connection") }),
    )
    expect(tool).toBeDefined()
    const result = await f.runtime.run(() =>
      ScopeContext.provide({
        scope,
        workspace: null,
        fn: () =>
          tool!.execute(
            { resourceID: f.connectionResource!.resourceID, body: { operationID: "tool-op", input: "payload" } },
            {
              sessionID: f.sessionID,
              messageID: "assistant-tool-call",
              agent: "fixture",
              abort: new AbortController().signal,
              metadata() {},
              async ask() {},
            },
          ),
      }),
    )
    expect(result.output).toBe(JSON.stringify({ operationID: "tool-op", accepted: true }))
    expect(result.metadata).toMatchObject({
      resourceID: f.connectionResource!.resourceID,
      status: 200,
      truncated: false,
    })
    expect(received).toEqual([
      {
        authorization: "Bearer private-connection-key",
        caller: null,
        body: { operationID: "tool-op", input: "payload" },
      },
    ])
    expect(JSON.stringify(result)).not.toContain("private-connection-key")
  } finally {
    await upstream.stop(true)
  }
})

test("native organization connection tool rejects an unselected or non-fixed resource before dispatch", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ unexpected: true }) })
  try {
    await using f = await execution({ execution: true, connectionEndpoint: new URL("/business", upstream.url).href })
    await f.binding()
    const scope = (await f.runtime.run(() => Session.get(f.sessionID))).scope
    const tool = (await f.runtime.run(() =>
      ScopeContext.provide({ scope, workspace: null, fn: () => ToolRegistry.find("organization_connection") }),
    ))!
    await expect(
      f.runtime.run(() =>
        ScopeContext.provide({
          scope,
          workspace: null,
          fn: () =>
            tool.execute(
              { resourceID: f.model.resourceID, body: { unexpected: true } },
              {
                sessionID: f.sessionID,
                messageID: "assistant-tool-call",
                agent: "fixture",
                abort: new AbortController().signal,
                metadata() {},
                async ask() {},
              },
            ),
        }),
      ),
    ).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED", outcome: "not_dispatched" } })
  } finally {
    await upstream.stop(true)
  }
})

test("native organization MCP tool invokes the selected remote tool through the service adapter", async () => {
  const servers = new Set<McpServer>()
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const mcp = new McpServer({ name: "runtime-mcp-fixture", version: "1.0.0" })
      mcp.registerTool("remote_ping", { description: "Runtime fixture ping" }, async () => ({
        content: [{ type: "text", text: "runtime-pong" }],
      }))
      servers.add(mcp)
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
      await mcp.connect(transport)
      return transport.handleRequest(request)
    },
  })
  try {
    await using f = await execution({
      execution: true,
      connectionEndpoint: new URL("/mcp", upstream.url).href,
      connectionProtocol: "mcp-http",
    })
    const scope = (await f.runtime.run(() => Session.get(f.sessionID))).scope
    await f.runtime.run(() => SessionExecutionSource.authorize({ sessionID: f.sessionID, scopeID: scope.id }))
    await f.binding()
    const tool = await f.runtime.run(() =>
      ScopeContext.provide({ scope, workspace: null, fn: () => ToolRegistry.find("organization_mcp") }),
    )
    expect(tool).toBeDefined()
    const result = await f.runtime.run(() =>
      ScopeContext.provide({
        scope,
        workspace: null,
        fn: () =>
          tool!.execute(
            {
              resourceID: f.connectionResource!.resourceID,
              operation: "call-tool",
              name: "remote_ping",
            },
            {
              sessionID: f.sessionID,
              messageID: "assistant-mcp-tool-call",
              agent: "fixture",
              abort: new AbortController().signal,
              metadata() {},
              async ask() {},
            },
          ),
      }),
    )
    expect(result.output).toBe(JSON.stringify({ content: [{ type: "text", text: "runtime-pong" }] }))
    expect(result.metadata).toMatchObject({
      resourceID: f.connectionResource!.resourceID,
      operation: "call-tool",
      truncated: false,
    })
    expect(JSON.stringify(result)).not.toContain("private-connection-key")
  } finally {
    await Promise.all([...servers].map((server) => server.close().catch(() => undefined)))
    servers.clear()
    await upstream.stop(true)
  }
})
