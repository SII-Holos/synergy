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
