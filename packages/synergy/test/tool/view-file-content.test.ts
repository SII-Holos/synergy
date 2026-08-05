import { describe, expect, test } from "bun:test"
import path from "path"
import { ViewFileTool } from "../../src/tool/view-file"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test-hashline-view-content",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.view_file content metadata", () => {
  test("returns full file contents in metadata when the snapshot cap is satisfied", async () => {
    const content = "const a = 1\nconst b = 2\nconst c = 3\n"
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "src.ts"), content)
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await ViewFileTool.init()
        const result = await tool.execute({ filePath: path.join(tmp.path, "src.ts") }, ctx)

        expect(result.metadata.content).toBe(content)
        expect(result.metadata.snapshotAvailable).toBe(true)
      },
    })
  })

  test("omits content for oversized files beyond the snapshot cap", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // 5 MB of text exceeds SNAPSHOT_MAX_BYTES (4 MiB); the tool falls
        // back to a capped byte preview without a snapshot.
        const big = `${"x".repeat(1024)}\n`.repeat(5 * 1024)
        await Bun.write(path.join(dir, "big.txt"), big)
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await ViewFileTool.init()
        const result = await tool.execute({ filePath: path.join(tmp.path, "big.txt") }, ctx)

        expect(result.metadata.content).toBeUndefined()
        expect(result.metadata.snapshotAvailable).toBe(false)
        // The raw text output is still produced for the agent.
        expect(typeof result.output).toBe("string")
      },
    })
  })

  test("returns full contents with ranges metadata for multi-range views", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
    const content = `${lines.join("\n")}\n`
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "multi.txt"), content)
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await ViewFileTool.init()
        const result = await tool.execute(
          {
            filePath: path.join(tmp.path, "multi.txt"),
            ranges: [
              { offset: 0, limit: 2 },
              { offset: 10, limit: 2 },
            ],
          },
          ctx,
        )

        expect(result.metadata.content).toBe(content)
        expect(result.metadata.ranges).toHaveLength(2)
        expect(result.metadata.ranges[0].startLine).toBe(1)
        expect(result.metadata.ranges[1].startLine).toBe(11)
      },
    })
  })
})
