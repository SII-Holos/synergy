import { describe, expect, test } from "bun:test"
import path from "path"
import { ScopeContext } from "../../src/scope/context"
import { WriteTool } from "../../src/tool/write"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test-write",
  messageID: "",
  callID: "",
  agent: "synergy",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.write", () => {
  test("returns diff metadata for the final file content", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "notes.md")
        const content = "# Notes\n\nBalanced details stay specialized.\n"
        const tool = await WriteTool.init()

        const result = await tool.execute({ filePath, content }, ctx)

        expect(await Bun.file(filePath).text()).toBe(content)
        expect(result.metadata.diff).toContain("Balanced details stay specialized.")
        expect(result.metadata.filediff).toMatchObject({
          file: "notes.md",
          additions: 3,
          deletions: 0,
          afterBytes: Buffer.byteLength(content, "utf8"),
        })
        expect(result.metadata.filediff.preview).toBe(result.metadata.diff)
      },
    })
  })
})
