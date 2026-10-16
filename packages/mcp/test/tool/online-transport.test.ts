import { expect, test } from "bun:test"
import type { JSONSchema7 } from "ai"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ToolMcpSource } from "@ericsanchezok/synergy-harness/tool/mcp-source"
import { MCP } from "../../src"
import { McpSupervisor } from "../../src/supervisor"
import { testRuntime } from "../support/runtime"

test("a real same-name MCP connection keeps its source, schema, bearer transport and raw contract", async () => {
  const calls: unknown[] = []
  const schema: JSONSchema7 = { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer fixture-only")
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const input = (await request.json()) as { id?: string | number; method: string; params?: unknown }
      if (input.id === undefined) return new Response(null, { status: 202 })
      if (input.method === "tools/call") calls.push(input.params)
      return Response.json({
        jsonrpc: "2.0",
        id: input.id,
        result:
          input.method === "initialize"
            ? {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              }
            : input.method === "tools/list"
              ? { tools: [{ name: "search", description: "User-owned web contract", inputSchema: schema }] }
              : { content: [{ type: "text", text: "verified source" }] },
      })
    },
  })
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const supervisor = McpSupervisor()
        await supervisor.ready()
        const handle = supervisor.getOrCreate("anysearch", {
          type: "remote",
          url: server.url.toString(),
          headers: { Authorization: "Bearer fixture-only" },
          oauth: false,
          startup: "manual",
          requiresWorkspace: false,
        })
        try {
          await supervisor.connect(handle.name, handle.identity)
          const raw = (await MCP.toolEntries()).find((tool) => tool.id === "mcp__anysearch__search")!
          expect(raw.source).toBe("runtime")
          expect(raw.tool.description).toBe("User-owned web contract")
          const presented = (await ToolMcpSource.get()!.toolEntries()).find((tool) => tool.id === raw.id)!
          expect(presented.presentation?.exposure).toMatchObject({ mode: "group", group: "mcp:anysearch" })
          expect(presented.presentation?.description).toBeUndefined()
          expect(presented.inputSchema).toEqual({ ...schema, additionalProperties: false })
          const result = await presented.tool.execute!(
            { query: "fixture query" },
            { toolCallId: "fixture", messages: [] },
          )
          expect(result).toMatchObject({ content: [{ type: "text", text: "verified source" }] })
          expect(calls).toEqual([{ name: "search", arguments: { query: "fixture query" } }])
          expect(supervisor.get("anysearch")!.toolDefs[0]!.description).toBe("User-owned web contract")
        } finally {
          await supervisor.remove(handle.name)
        }
      },
    }),
  )
})
