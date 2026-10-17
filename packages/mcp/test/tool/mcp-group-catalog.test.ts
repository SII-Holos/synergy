import { describe, expect, spyOn, test } from "bun:test"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { MCP } from "@ericsanchezok/synergy-mcp"
import { jsonSchema } from "ai"
import { ToolDiscovery } from "@ericsanchezok/synergy-harness/test/internal/tool/discovery"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ExpandToolsTool } from "@ericsanchezok/synergy-harness/test/internal/tool/expand-tools"
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
          const expand = await ExpandToolsTool.init({ agent: allowAllAgent })
          expect(expand.description).toContain("search_tools")
          expect(expand.description).not.toContain("mcp:anysearch")
          expect(source).not.toHaveBeenCalled()
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
