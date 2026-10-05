import { expect, test } from "bun:test"
import { cortexTools, registerCortexToolInputHistory } from "../../src/cortex/tools"
import { Tool } from "../../src/tool/tool"
import { MigrationRegistry } from "../../src/migration/registry"
import { testRuntime } from "../support/runtime"

const toolkit = cortexTools()

test("selective Cortex hosts register task history without product tool registration", async () => {
  await using runtime = await testRuntime({
    register() {
      registerCortexToolInputHistory()
      registerCortexToolInputHistory()
    },
  })
  await runtime.run(async () => {
    expect(toolkit.map((tool) => tool.id)).toContain("task")
    expect(Tool.upgradeInput("task", { description: "Old title", taskTitle: "Current", prompt: "Inspect" })).toEqual({
      taskTitle: "Current",
      taskInstructions: "Inspect",
    })
    expect(Tool.upgradeInput("task_output", { task_id: "child" })).toEqual({ taskId: "child" })
    expect(Tool.upgradeInput("task_cancel", { task_id: "child" })).toEqual({ taskId: "child" })
    expect(MigrationRegistry.list().get("tool-input-cortex")).toHaveLength(1)
  })
  await using independent = await testRuntime()
  await independent.run(async () => {
    expect(Tool.upgradeInput("task", { prompt: "Unregistered" })).toEqual({ prompt: "Unregistered" })
    expect(MigrationRegistry.list().has("tool-input-cortex")).toBe(false)
  })
})
