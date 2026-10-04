import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { registerLocalRuntime } from "../../src/register"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("registry folds all orchestration tools only for the lightweight primary", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const flash = await Agent.get(PrimaryAgentIdentity.names.lightweight)
        const synergy = await Agent.get(PrimaryAgentIdentity.names.general)
        expect(flash).toBeDefined()
        expect(synergy).toBeDefined()

        const flashTools = await ToolRegistry.tools("test-provider", flash)
        const flashById = new Map(flashTools.map((tool) => [tool.id, tool]))
        expect(flash?.deferredTools).toEqual([
          "task",
          "task_list",
          "task_output",
          "task_cancel",
          "dagwrite",
          "dagread",
          "dagpatch",
        ])
        for (const id of ["task", "task_list", "task_output", "task_cancel", "dagwrite", "dagread", "dagpatch"]) {
          expect(flashById.get(id)?.exposure).toMatchObject({ mode: "group", group: "orchestration" })
        }
        expect(flashById.get("bash")?.exposure).toEqual({ mode: "resident" })
        expect(flashById.get("skill")?.exposure).toEqual({ mode: "resident" })

        const synergyTools = await ToolRegistry.tools("test-provider", synergy)
        const synergyById = new Map(synergyTools.map((tool) => [tool.id, tool]))
        expect(synergyById.get("dagwrite")?.exposure).toEqual({ mode: "resident" })
      },
    })
  }))

afterRuntimeTests(() => runtime.close())
