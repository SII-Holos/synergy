import { describe, expect, test } from "bun:test"
import path from "path"
import { WriteTool } from "@ericsanchezok/synergy-local-runtime/tools/write"
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

describe("tool.write auto runtime reload", () => {
  test("reloads config when writing synergy config file", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await WriteTool.init()
          const result = await tool.execute(
            {
              filePath: path.join(tmp.path, ".synergy", "synergy.jsonc"),
              content: JSON.stringify({
                $schema: "file:///test/config.schema.json",
                model: "openai/gpt-5",
              }),
            },
            ctx,
          )

          expect(result.metadata.runtimeReload).toBeDefined()
          const runtimeReload = result.metadata.runtimeReload!
          expect(runtimeReload.requested).toContain("config")
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
