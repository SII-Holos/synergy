import { expect, test } from "bun:test"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalToolInputHistory } from "../../src/tool-input-history"

test("selective local tools retain shell intent history without native providers", async () => {
  await using runtime = await testRuntime({ register: registerLocalToolInputHistory })
  await runtime.run(async () => {
    expect(Tool.upgradeInput("bash", { command: "pwd", description: "Inspect" })).toEqual({
      command: "pwd",
      workBrief: "Inspect",
    })
    expect(MigrationRegistry.list().get("tool-input-local-runtime")).toHaveLength(1)
  })
})
