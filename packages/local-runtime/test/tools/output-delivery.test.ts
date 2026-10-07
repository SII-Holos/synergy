import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"

test("local tool catalog has no separate attachment delivery operation", async () => {
  await using runtime = await testRuntime()
  await using tmp = await tmpdir()
  await runtime.run(async () =>
    ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tools = await ToolRegistry.ids()
        expect(tools).toContain("view_image")
        expect(tools).not.toContain("attach")
      },
    }),
  )
})
