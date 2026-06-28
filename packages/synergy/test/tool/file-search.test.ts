import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ScopeContext } from "../../src/scope/context"
import { FileSearchTool } from "../../src/tool/file-search"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test-file-search",
  messageID: "",
  callID: "",
  agent: "implementation-engineer",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.file_search", () => {
  test("uses workspace file search to return fuzzy path matches", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "src", "components"), { recursive: true })
        await Bun.write(path.join(dir, "src", "components", "file-panel.tsx"), "export const FilePanel = 1")
      },
    })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await FileSearchTool.init()
        const result = await tool.execute({ query: "file panel" }, ctx)
        expect(result.output).toContain("file src/components/file-panel.tsx")
        expect(result.metadata.count).toBeGreaterThan(0)
        expect(result.metadata.results[0]?.kind).toBe("file")
      },
    })
  })
})
