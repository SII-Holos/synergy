import { describe, expect, test } from "bun:test"
import path from "path"
import { ReadTool } from "../../src/tool/read"
import { Instance } from "../../src/scope/instance"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test-read-offset",
  messageID: "",
  callID: "",
  agent: "developer",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

/**
 * The read tool uses `params.offset ?? 0` to handle zero-valued offsets.
 * Prior to the fix, `offset || 0` would fall through to 0 when offset was
 * explicitly 0 (since 0 is falsy), breaking the behavior.
 *
 * Note: read enforces MIN_READ_LIMIT = 120, so any explicit limit < 120
 * gets bumped to 120. We create files with >120 lines to make offset
 * tests meaningful.
 */
function manyLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line${i}`).join("\n")
}

describe("tool.read offset=0 fix", () => {
  test("offset=0 is not treated as falsy (was || 0 bug)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "data.txt"), manyLines(150))
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const read = await ReadTool.init()

        // Explicit offset=0
        const r0 = await read.execute(
          {
            filePath: path.join(tmp.path, "data.txt"),
            offset: 0,
            limit: 5,
          },
          ctx,
        )

        // Omitting offset entirely should produce the same first line
        const rDefault = await read.execute(
          {
            filePath: path.join(tmp.path, "data.txt"),
            limit: 5,
          },
          ctx,
        )

        // Both should start with the first line
        expect(r0.output).toContain("line0")
        expect(r0.metadata.offset).toBe(0)

        // First line in both should be identical
        expect(r0.metadata.preview).toBe(rDefault.metadata.preview)
      },
    })
  })

  test("offset=1 correctly skips the first line", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "offset.txt"), manyLines(150))
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const read = await ReadTool.init()

        const result = await read.execute(
          {
            filePath: path.join(tmp.path, "offset.txt"),
            offset: 1,
          },
          ctx,
        )

        expect(result.metadata.offset).toBe(1)
        // Should contain line1 but not line0
        expect(result.output).toContain("line1")
      },
    })
  })

  test("offset=0 and offset=omitted produce same offset metadata", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "same.txt"), manyLines(200))
      },
    })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const read = await ReadTool.init()

        const rZero = await read.execute(
          {
            filePath: path.join(tmp.path, "same.txt"),
            offset: 0,
          },
          ctx,
        )

        const rDefault = await read.execute(
          {
            filePath: path.join(tmp.path, "same.txt"),
          },
          ctx,
        )

        expect(rZero.metadata.offset).toBe(rDefault.metadata.offset)
      },
    })
  })
})
