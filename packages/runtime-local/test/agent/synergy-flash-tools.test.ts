import { expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { registerLocalRuntime } from "../../src/register"

registerLocalRuntime()

test("registry folds orchestration tools only for synergy-flash", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const flash = await Agent.get("synergy-flash")
      const synergy = await Agent.get("synergy")
      expect(flash).toBeDefined()
      expect(synergy).toBeDefined()

      const flashTools = await ToolRegistry.tools("test-provider", flash)
      const flashById = new Map(flashTools.map((tool) => [tool.id, tool]))
      for (const id of ["dagwrite", "dagread", "dagpatch"]) {
        expect(flashById.get(id)?.exposure).toMatchObject({ mode: "group", group: "orchestration" })
      }
      expect(flashById.get("bash")?.exposure).toEqual({ mode: "resident" })
      expect(flashById.get("skill")?.exposure).toEqual({ mode: "resident" })

      const synergyTools = await ToolRegistry.tools("test-provider", synergy)
      const synergyById = new Map(synergyTools.map((tool) => [tool.id, tool]))
      expect(synergyById.get("dagwrite")?.exposure).toEqual({ mode: "resident" })
    },
  })
})

test("shared file-routing descriptions respect native agent tool availability", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const descriptions = await Promise.all(
        ["synergy-flash", "synergy", "synergy-max"].map(async (name) => {
          const agent = await Agent.get(name)
          expect(agent).toBeDefined()
          const tools = await ToolRegistry.tools("test-provider", agent)
          return {
            agent: name,
            bash: tools.find((tool) => tool.id === "bash")?.description,
            file_search: tools.find((tool) => tool.id === "file_search")?.description,
          }
        }),
      )
      for (const description of descriptions) {
        expect(description.bash, `${description.agent}: unconditional bash routing`).not.toContain(
          "Prefer dedicated tools over shell equivalents: Glob for file search (not find/ls), Grep for content search (not grep/rg)",
        )
        expect(description.file_search, `${description.agent}: unconditional file_search routing`).not.toContain(
          "For regex content search with anchored editable results, use scan_files. For syntax-aware queries, use parse_code. For file reading, use view_file.",
        )
        expect(description.bash).toContain(
          "When available, prefer Glob for file search and Grep for content search; otherwise use file_search.",
        )
        expect(description.file_search).toContain("Use scan_files, parse_code, and view_file only when available.")
        for (const tool of ["bash", "file_search"] as const) {
          expect(description[tool]).toContain("Use the available file-reading tool: read or view_file.")
          expect(description[tool]).toContain("Tool expansion does not bypass agent permissions.")
        }
      }
    },
  })
})
