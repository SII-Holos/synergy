import { describe, expect, test } from "bun:test"
import path from "path"
import { WriteTool } from "../../src/tool/write"
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

describe("tool.write auto runtime reload", () => {
  test("reloads config when writing synergy config file", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
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
  })
})
