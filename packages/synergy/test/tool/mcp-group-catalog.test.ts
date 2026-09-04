import { afterEach, describe, expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { MCP } from "../../src/mcp"
import { PermissionNext } from "../../src/permission/next"
import { ScopeContext } from "../../src/scope/context"
import { ExpandToolsTool } from "../../src/tool/expand-tools"
import { ToolExposure } from "../../src/tool/exposure"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const allowAllAgent: Agent.Info = {
  name: "synergy",
  mode: "primary",
  permission: PermissionNext.fromConfig({ "*": "allow" }),
  options: {},
}

const originalDeferredGroupCatalog = MCP.deferredGroupCatalog

function mockDeferredGroupCatalog(catalog: Awaited<ReturnType<typeof MCP.deferredGroupCatalog>>) {
  ;(MCP as any).deferredGroupCatalog = async () => catalog
}

afterEach(() => {
  ;(MCP as any).deferredGroupCatalog = originalDeferredGroupCatalog
})

describe("ToolExposure.mcpGroupTable", () => {
  test("returns empty string for no servers", () => {
    expect(ToolExposure.mcpGroupTable([])).toBe("")
  })

  test("renders header and a single server row with group id, count, tool names, and hint", () => {
    const table = ToolExposure.mcpGroupTable([
      { serverName: "anysearch", toolNames: ["search", "batch_search", "extract", "get_sub_domains"] },
    ])
    const lines = table.split("\n")
    expect(lines[0]).toBe("| Group | What it does | When to expand |")
    expect(lines[1]).toBe("| --- | --- | --- |")
    expect(lines[2]).toBe(
      '| mcp:anysearch | anysearch (4 tools): batch_search, extract, get_sub_domains, search | Expand with expand_tools({groups:["mcp:anysearch"]}) when a task needs this server. |',
    )
  })

  test("deduplicates and sorts tool names", () => {
    const table = ToolExposure.mcpGroupTable([{ serverName: "s", toolNames: ["b", "a", "b", "c"] }])
    expect(table).toContain("s (3 tools): a, b, c")
  })

  test("caps tool names at six and reports the remainder", () => {
    const toolNames = Array.from({ length: 8 }, (_, i) => `tool_${i}`)
    const table = ToolExposure.mcpGroupTable([{ serverName: "s", toolNames }])
    expect(table).toContain("tool_0, tool_1, tool_2, tool_3, tool_4, tool_5")
    expect(table).toContain("… and 2 more")
  })

  test("caps servers at ten and reports the remainder", () => {
    const servers = Array.from({ length: 12 }, (_, i) => ({ serverName: `server-${i}`, toolNames: ["t"] }))
    const table = ToolExposure.mcpGroupTable(servers)
    const rows = table.split("\n").filter((line) => line.startsWith("| mcp:"))
    expect(rows).toHaveLength(10)
    expect(table).toContain("| … | +2 more servers | … |")
  })

  test("sanitizes server names into group ids", () => {
    const table = ToolExposure.mcpGroupTable([{ serverName: "My Server!", toolNames: ["t"] }])
    expect(table).toContain("| mcp:My_Server_ |")
  })
})

describe("ExpandToolsTool description with MCP group catalog", () => {
  test("includes connected MCP groups when servers are folded by default", async () => {
    await using tmp = await tmpdir({ config: {} })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        mockDeferredGroupCatalog({
          totalTools: 4,
          servers: [{ serverName: "anysearch", toolNames: ["search", "batch_search", "extract", "get_sub_domains"] }],
        })
        const expand = await ExpandToolsTool.init({ agent: allowAllAgent })
        expect(expand.description).toContain("Connected MCP groups:")
        expect(expand.description).toContain("mcp:anysearch")
        expect(expand.description).toContain('expand_tools({groups:["mcp:anysearch"]})')
        expect(expand.description).toContain("anysearch (4 tools):")
      },
    })
  })

  test("omits expandByDefault servers from the folded MCP groups section", async () => {
    await using tmp = await tmpdir({
      config: {
        mcp: {
          anysearch: { type: "remote", url: "http://127.0.0.1:9/mcp", expandByDefault: true },
        },
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        mockDeferredGroupCatalog({
          totalTools: 4,
          servers: [{ serverName: "anysearch", toolNames: ["search", "batch_search", "extract", "get_sub_domains"] }],
        })
        const expand = await ExpandToolsTool.init({ agent: allowAllAgent })
        expect(expand.description).not.toContain("Connected MCP groups:")
        expect(expand.description).not.toContain("mcp:anysearch")
      },
    })
  })

  test("omits the MCP section when no servers are connected", async () => {
    await using tmp = await tmpdir({ config: {} })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        mockDeferredGroupCatalog({ totalTools: 0, servers: [] })
        const expand = await ExpandToolsTool.init({ agent: allowAllAgent })
        expect(expand.description).not.toContain("Connected MCP groups:")
      },
    })
  })

  test("initialization does not throw with an empty supervisor catalog", async () => {
    await using tmp = await tmpdir({ config: {} })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const expand = await ExpandToolsTool.init({ agent: allowAllAgent })
        expect(expand.description).toContain("Known built-in groups:")
        expect(expand.description).not.toContain("Connected MCP groups:")
      },
    })
  })
})
