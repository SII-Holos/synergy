import { expect, test } from "bun:test"
import path from "node:path"
import { MCP } from "../../src/index"
import { McpSupervisor } from "../../src/supervisor"
import { ToolMcpSource } from "@ericsanchezok/synergy-harness/tool/mcp-source"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"
import definitions from "../fixtures/anysearch-tools.json"

const icon = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>').toString("base64")}`

test("model adaptation preserves raw discovery, schemas and the actual MCP call", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir()
    const server = path.join(tmp.path, "mcp.cjs")
    await Bun.write(
      server,
      `
const definitions = ${JSON.stringify(definitions)};
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const m = JSON.parse(line); if (m.id === undefined) return;
  const result = m.method === "initialize"
    ? {protocolVersion:m.params.protocolVersion, serverInfo:{name:"fixture",version:"1",icons:[{src:${JSON.stringify(icon)},theme:"light"}]},capabilities:{tools:{}}}
    : m.method === "tools/list" ? {tools:definitions}
    : {content:[{type:"text",text:JSON.stringify(m.params)}]};
  console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result}));
});`,
    )
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const supervisor = McpSupervisor()
        await supervisor.ready()
        const handle = supervisor.getOrCreate("anysearch", {
          type: "local",
          command: [process.execPath, server],
          startup: "manual",
        })
        try {
          await supervisor.connect(handle.name, handle.identity)
          const raw = await MCP.toolEntries()
          expect(raw[0]?.display?.icon).toMatchObject([{ mimeType: "image/svg+xml", theme: "light" }])
          const custom = await MCP.toolEntries({ audience: "model" })
          expect(custom.map((entry) => entry.tool.description)).toEqual(raw.map((entry) => entry.tool.description))
          handle.source = "builtin"
          handle.config = { type: "remote", url: "https://api.anysearch.com/mcp", requiresWorkspace: false }
          const snapshot = structuredClone(handle.toolDefs)
          expect((await ToolMcpSource.get()!.toolEntries()).map((entry) => entry.tool.description)).toEqual(
            raw.map((entry) => entry.tool.description),
          )
          const model = await ToolMcpSource.get()!.toolEntries({ audience: "model" })
          expect(model[0]?.display).toEqual(raw[0]?.display)
          for (const entry of model)
            expect(entry.presentation?.description ?? entry.tool.description).toBe(entry.tool.description)
          expect(model.map((entry) => entry.inputSchema)).toEqual(raw.map((entry) => entry.inputSchema))
          expect(model.map((entry) => entry.id)).toEqual(raw.map((entry) => entry.id))
          for (const [index, entry] of model.entries())
            expect(entry.tool.description!.length).toBeLessThan(raw[index]!.tool.description!.length)
          expect(handle.toolDefs).toEqual(snapshot)
          expect((await MCP.toolEntries()).map((entry) => entry.tool.description)).toEqual(
            raw.map((entry) => entry.tool.description),
          )
          const search = model.find((entry) => entry.toolName === "search")!
          const args = { query: "fixture query", max_results: 2 }
          const result = await search.tool.execute!(args, {
            toolCallId: "fixture",
            context: {},
            messages: [],
            abortSignal: new AbortController().signal,
          })
          expect(result).toMatchObject({
            content: [{ type: "text", text: JSON.stringify({ name: "search", arguments: args }) }],
          })
          handle.toolDefs[0] = { ...handle.toolDefs[0]!, icons: [{ src: icon, theme: "dark" }] }
          const withToolIcon = await ToolMcpSource.get()!.toolEntries()
          expect(withToolIcon[0]?.display?.icon).toMatchObject([{ src: icon, theme: "dark" }])
          expect(withToolIcon[1]?.display?.icon).toMatchObject([{ src: icon, theme: "light" }])
          handle.toolDefs[0]!.description += " Updated remote contract."
          expect((await MCP.toolEntries({ audience: "model" }))[0]!.tool.description).toBe(
            handle.toolDefs[0]!.description,
          )
          const changed = (await ToolMcpSource.get()!.toolEntries({ audience: "model" }))[0]!
          expect(changed.presentation?.description ?? changed.tool.description).toBe(handle.toolDefs[0]!.description)
          await supervisor.disconnect(handle.name)
          expect(await MCP.toolEntries({ audience: "model" })).toEqual([])
        } finally {
          await supervisor.remove(handle.name)
        }
      },
    })
  })
})
