import { describe, expect, spyOn, test } from "bun:test"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { MCP } from "@ericsanchezok/synergy-mcp"
import { jsonSchema } from "ai"
import { ToolDiscovery } from "@ericsanchezok/synergy-harness/test/internal/tool/discovery"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ExpandToolsTool } from "@ericsanchezok/synergy-harness/test/internal/tool/expand-tools"
import { ToolExposure } from "@ericsanchezok/synergy-harness/tool/exposure"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

runtime.run(() => Log.init({ print: false }))

const allowAllAgent: Agent.Info = {
  name: "synergy",
  mode: "primary",
  permission: PermissionNext.fromConfig({ "*": "allow" }),
  options: {},
}

describe("ToolExposure.mcpGroupTable", () => {
  test("returns empty string for no servers", () =>
    runtime.run(() => {
      expect(ToolExposure.mcpGroupTable([])).toBe("")
    }))

  test("renders header and a single server row with group id, count, tool names, and hint", () =>
    runtime.run(() => {
      const table = ToolExposure.mcpGroupTable([
        { serverName: "anysearch", toolNames: ["search", "batch_search", "extract", "get_sub_domains"] },
      ])
      const lines = table.split("\n")
      expect(lines[0]).toBe("| Group | What it does | When to expand |")
      expect(lines[1]).toBe("| --- | --- | --- |")
      expect(lines[2]).toBe(
        '| mcp:anysearch | anysearch (4 tools): batch_search, extract, get_sub_domains, search | Expand with expand_tools({groups:["mcp:anysearch"]}) when a task needs this server. |',
      )
    }))

  test("deduplicates and sorts tool names", () =>
    runtime.run(() => {
      const table = ToolExposure.mcpGroupTable([{ serverName: "s", toolNames: ["b", "a", "b", "c"] }])
      expect(table).toContain("s (3 tools): a, b, c")
    }))

  test("caps tool names at six and reports the remainder", () =>
    runtime.run(() => {
      const toolNames = Array.from({ length: 8 }, (_, i) => `tool_${i}`)
      const table = ToolExposure.mcpGroupTable([{ serverName: "s", toolNames }])
      expect(table).toContain("tool_0, tool_1, tool_2, tool_3, tool_4, tool_5")
      expect(table).toContain("… and 2 more")
    }))

  test("caps servers at ten and reports the remainder", () =>
    runtime.run(() => {
      const servers = Array.from({ length: 12 }, (_, i) => ({ serverName: `server-${i}`, toolNames: ["t"] }))
      const table = ToolExposure.mcpGroupTable(servers)
      const rows = table.split("\n").filter((line) => line.startsWith("| mcp:"))
      expect(rows).toHaveLength(10)
      expect(table).toContain("| … | +2 more servers | … |")
    }))

  test("sanitizes server names into group ids", () =>
    runtime.run(() => {
      const table = ToolExposure.mcpGroupTable([{ serverName: "My Server!", toolNames: ["t"] }])
      expect(table).toContain("| mcp:My_Server_ |")
    }))
})

const entries: MCP.ToolEntry[] = ["search", "batch_search", "extract", "get_sub_domains"].map((name) => ({
  id: `mcp__anysearch__${name}`,
  serverName: "anysearch",
  toolName: name,
  tool: { description: `Anysearch ${name}`, inputSchema: jsonSchema({ type: "object" }) },
  inputSchema: { type: "object" },
}))

describe("MCP discovery respects the active caller", () => {
  for (const expandByDefault of [false, true])
    test(`available tools honor expandByDefault=${expandByDefault}`, () =>
      runtime.run(async () => {
        await using tmp = await tmpdir({
          config: {
            mcp: { anysearch: { type: "remote", url: "http://127.0.0.1:9/mcp", expandByDefault } },
          },
        })
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            using source = spyOn(MCP, "toolEntries").mockResolvedValue(entries)
            const catalog = await ToolDiscovery.collect({ providerID: "fixture", agent: allowAllAgent })
            const groups = ToolDiscovery.availableGroups(catalog).filter((group) => group.id === "mcp:anysearch")
            expect(groups).toHaveLength(expandByDefault ? 0 : 1)
            if (!expandByDefault) expect(groups[0].tools).toEqual(entries.map((entry) => entry.id).sort())
            const visible = ToolDiscovery.visibleTools(catalog)
            for (const entry of entries) expect(visible.includes(entry.id)).toBe(expandByDefault)
            const denied = await ToolDiscovery.collect({
              providerID: "fixture",
              agent: {
                ...allowAllAgent,
                permission: PermissionNext.fromConfig({ "*": "allow", "mcp__anysearch__*": "deny" }),
              },
            })
            expect(ToolDiscovery.availableGroups(denied).some((group) => group.id === "mcp:anysearch")).toBe(false)
            expect(ToolDiscovery.nonResidentEntries(denied).some((entry) => entry.id.includes("anysearch"))).toBe(false)
          },
        })
      }))

  test("initialization advertises discovery without embedding a process-wide catalog", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ config: {} })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          using source = spyOn(MCP, "toolEntries").mockResolvedValue(entries)
          using catalog = spyOn(MCP, "deferredGroupCatalog").mockResolvedValue({
            totalTools: entries.length,
            servers: [{ serverName: "anysearch", toolNames: entries.map((entry) => entry.toolName) }],
          })
          const expand = await ExpandToolsTool.init({ agent: allowAllAgent })
          expect(expand.description).toContain("search_tools")
          expect(expand.description).not.toContain("mcp:anysearch")
          expect(source).not.toHaveBeenCalled()
          expect(catalog).not.toHaveBeenCalled()
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
