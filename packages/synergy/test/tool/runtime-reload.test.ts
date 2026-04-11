import { describe, expect, test } from "bun:test"
import { RuntimeReloadTool } from "../../src/tool/runtime-reload"
import { Instance } from "../../src/scope/instance"
import { tmpdir } from "../fixture/fixture"

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
  test("returns structured reload summary", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
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
  })
})
