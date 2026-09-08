import { expect, test } from "bun:test"
import path from "node:path"
import { McpSupervisor } from "../../src/mcp/supervisor"
import { MCP } from "../../src/mcp"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

test("MCP manual owner connects real stdio capabilities, reads resources and releases its client", async () => {
  await using tmp = await tmpdir()
  const server = path.join(tmp.path, "mcp-fixture.cjs")
  await Bun.write(
    server,
    `const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line); if (m.id === undefined) return;
  let result = {};
  if(m.method === "initialize") result = { protocolVersion: m.params.protocolVersion, serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {}, prompts: {}, resources: {} } };
  else if(m.method === "tools/list") result = { tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] };
  else if(m.method === "tools/call") result = { content: [{ type: "text", text: m.params.arguments.text }] };
  else if(m.method === "prompts/list") result = { prompts: [{ name: "review", description: "Review" }] };
  else if(m.method === "prompts/get") result = { messages: [{ role: "user", content: { type: "text", text: "review evidence" } }] };
  else if(m.method === "resources/list") result = { resources: [{ uri: "fixture://evidence", name: "evidence", mimeType: "text/plain" }] };
  else if(m.method === "resources/read") result = { contents: [{ uri: "fixture://evidence", mimeType: "text/plain", text: "stored evidence" }] };
  console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
});`,
  )
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      try {
        await McpSupervisor.ready()
        const name = `fixture-${crypto.randomUUID()}`
        const config = { type: "local" as const, command: [process.execPath, server], startup: "manual" as const }
        const handle = McpSupervisor.getOrCreate(name, config)
        expect(McpSupervisor.getOrCreate(name, config)).toBe(handle)
        expect(McpSupervisor.getClient(name)).toBeUndefined()
        await expect(McpSupervisor.connect(name, "stale identity")).rejects.toThrow("not found")
        await McpSupervisor.connect(name, handle.identity)
        expect(McpSupervisor.test(name)).toEqual({ status: "connected" })
        await McpSupervisor.refresh(name)
        expect(McpSupervisor.inspect(name)).toMatchObject({
          toolNames: ["echo"],
          resourceNames: ["evidence"],
          promptNames: ["review"],
        })
        expect((await MCP.listServers()).find((server) => server.name === name)?.source).toBe("runtime")
        expect((await MCP.getPrompt(name, "review"))?.messages[0]?.content).toEqual({
          type: "text",
          text: "review evidence",
        })
        expect((await MCP.readResource(name, "fixture://evidence"))?.contents[0]).toMatchObject({
          text: "stored evidence",
        })
        expect(
          (await McpSupervisor.getClient(name)!.callTool({ name: "echo", arguments: { text: "actual request" } }))
            .content,
        ).toEqual([{ type: "text", text: "actual request" }])
        expect(McpSupervisor.resourceStats().processCount).toBe(1)
        await McpSupervisor.disconnect(name)
        expect(McpSupervisor.test(name)).toEqual({ status: "disabled" })
        expect(McpSupervisor.getClient(name)).toBeUndefined()
        await McpSupervisor.remove(name)
        expect(McpSupervisor.inspect(name)).toBeUndefined()
        expect(await MCP.getPrompt(name, "review")).toBeUndefined()
        expect(await MCP.readResource(name, "fixture://evidence")).toBeUndefined()
      } finally {
        await McpSupervisor.reset()
      }
    },
  })
})
