import { describe, expect, test } from "bun:test"
import { RuntimeReloadTool } from "@ericsanchezok/synergy-runtime-local/tools/runtime-reload"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { RuntimeReload } from "@ericsanchezok/synergy-product-runtime/runtime/reload"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "synergy",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.runtime_reload", () => {
  test("returns structured reload summary", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await RuntimeReloadTool.init()
          const result = await tool.execute({ target: "all", scope: "global", reason: "test" }, ctx)

          expect(result.title).toBe("runtime_reload")
          expect(result.output).toContain("Runtime reload completed")
          expect(result.metadata.success).toBe(true)
          expect(result.metadata.executed).toContain("config")
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
