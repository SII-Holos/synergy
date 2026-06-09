import { describe, expect, test } from "bun:test"
import path from "path"
import { ViewFileTool } from "../../src/tool/view-file"
import { Instance } from "../../src/scope/instance"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test-hashline-view",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.view_file", () => {
  describe("basic file reading", () => {
    test("reads a plain text file and returns hashline output", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "hello.txt"), "hello world\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ViewFileTool.init()
          const result = await tool.execute({ filePath: path.join(tmp.path, "hello.txt") }, ctx)

          // Head hashline header [relative/path#TAG]
          expect(result.output).toMatch(/^\[.*#([0-9A-F]{4})\]\n/)
          // Content in LINE:TEXT format with zero-padded 5-digit line numbers
          expect(result.output).toContain("1:hello world")
          // Should be a full-file snapshot stored for the session
          expect(result.metadata.tag).toMatch(/^[0-9A-F]{4}$/)
          expect(result.metadata.path).toBe("hello.txt")
        },
      })
    })

    test("returns relative display path in header", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "sub", "deep", "file.ts"), "const x = 1\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ViewFileTool.init()
          const result = await tool.execute({ filePath: path.join(tmp.path, "sub", "deep", "file.ts") }, ctx)

          expect(result.output).toMatch(/^\[sub\/deep\/file\.ts#[0-9A-F]{4}\]\n/)
        },
      })
    })
  })

  describe("multi-line content", () => {
    test("renders all lines with correct numbering", async () => {
      const content = "line 1\nline 2\nline 3\nline 4\nline 5\n"
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "multi.txt"), content)
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ViewFileTool.init()
          const result = await tool.execute({ filePath: path.join(tmp.path, "multi.txt") }, ctx)

          expect(result.output).toContain("1:line 1")
          expect(result.output).toContain("5:line 5")
          // No extra line 6
          expect(result.output).not.toContain("6:")
        },
      })
    })

    test("handles empty file", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "empty.txt"), "")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ViewFileTool.init()
          const result = await tool.execute({ filePath: path.join(tmp.path, "empty.txt") }, ctx)

          expect(result.output).toMatch(/^\[.*#[0-9A-F]{4}\]\n$/)
          expect(result.metadata.tag).toMatch(/^[0-9A-F]{4}$/)
        },
      })
    })
  })

  describe("tag property", () => {
    test("tag is content-derived, not a counter", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "a.txt"), "content A\n")
          await Bun.write(path.join(dir, "b.txt"), "content B\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ViewFileTool.init()

          // Read a.txt twice — same tag
          const r1 = await tool.execute({ filePath: path.join(tmp.path, "a.txt") }, ctx)
          const r2 = await tool.execute({ filePath: path.join(tmp.path, "a.txt") }, ctx)
          expect(r1.metadata.tag).toBe(r2.metadata.tag)

          // Different file has different tag
          const r3 = await tool.execute({ filePath: path.join(tmp.path, "b.txt") }, ctx)
          expect(r3.metadata.tag).not.toBe(r1.metadata.tag)
        },
      })
    })

    test("tag changes when content changes", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "mod.txt"), "original content\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ViewFileTool.init()

          const r1 = await tool.execute({ filePath: path.join(tmp.path, "mod.txt") }, ctx)
          const tag1 = r1.metadata.tag

          // Modify the file
          await Bun.write(path.join(tmp.path, "mod.txt"), "modified content\n")

          const r2 = await tool.execute({ filePath: path.join(tmp.path, "mod.txt") }, ctx)
          const tag2 = r2.metadata.tag

          expect(tag1).not.toBe(tag2)
        },
      })
    })
  })

  describe("error handling", () => {
    test("throws for non-existent file", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ViewFileTool.init()
          await expect(tool.execute({ filePath: path.join(tmp.path, "nonexistent.txt") }, ctx)).rejects.toThrow()
        },
      })
    })

    test("throws for directory path", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ViewFileTool.init()
          await expect(tool.execute({ filePath: tmp.path }, ctx)).rejects.toThrow()
        },
      })
    })
  })

  describe("multi-range access", () => {
    test("accepts ranges parameter and displays selected regions", async () => {
      const content = "line01\nline02\nline03\nline04\nline05\nline06\nline07\nline08\nline09\nline10\n"
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "multi.txt"), content)
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ViewFileTool.init()
          const result = await tool.execute(
            {
              filePath: path.join(tmp.path, "multi.txt"),
              ranges: [
                { offset: 0, limit: 3 },
                { offset: 6, limit: 2 },
              ],
            },
            ctx,
          )

          // Single header for all ranges
          const headerCount = result.output.match(/^\[.*#[0-9A-F]{4}\]$/gm)?.length ?? 0
          expect(headerCount).toBe(1)

          // First range lines
          expect(result.output).toContain("1:line01")
          expect(result.output).toContain("3:line03")
          // Second range lines (1-based, offset=6 => line 7)
          expect(result.output).toContain("7:line07")
          expect(result.output).toContain("8:line08")
          // Lines outside both ranges should NOT appear
          expect(result.output).not.toContain("4:line04")
          expect(result.output).not.toContain("9:line09")

          // Full file is still snapshotted (tag covers all 10 lines)
          expect(result.metadata.tag).toMatch(/^[0-9A-F]{4}$/)
          expect(result.metadata.totalLines).toBe(10)
        },
      })
    })

    test("enforces minimum line limit of 120 when limit is set explicitly", async () => {
      const content = "line01\nline02\nline03\nline04\nline05\n"
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "legacy.txt"), content)
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ViewFileTool.init()
          const result = await tool.execute(
            {
              filePath: path.join(tmp.path, "legacy.txt"),
              offset: 2,
              limit: 2,
            },
            ctx,
          )

          expect(result.output).toContain("3:line03")
          expect(result.output).toContain("4:line04")
          expect(result.output).not.toContain("1:line01")
          expect(result.metadata.offset).toBe(2)
          expect(result.metadata.limit).toBe(120)
          expect(result.metadata.totalLines).toBe(5)
        },
      })
    })

    test("empty range produces no body content but still has header", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "file.txt"), "some content\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ViewFileTool.init()
          const result = await tool.execute(
            {
              filePath: path.join(tmp.path, "file.txt"),
              ranges: [{ offset: 0, limit: 0 }],
            },
            ctx,
          )

          // Header present, no body lines
          expect(result.output).toMatch(/^\[.*#[0-9A-F]{4}\]\n$/)
          expect(result.metadata.tag).toMatch(/^[0-9A-F]{4}$/)
        },
      })
    })

    test("range overlapping end of file displays only available lines", async () => {
      const content = "a\nb\n"
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "short.txt"), content)
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ViewFileTool.init()
          const result = await tool.execute(
            {
              filePath: path.join(tmp.path, "short.txt"),
              ranges: [{ offset: 0, limit: 5 }],
            },
            ctx,
          )

          expect(result.output).toContain("1:a")
          expect(result.output).toContain("2:b")
          expect(result.output).not.toContain("3:")
        },
      })
    })

    test("range starting beyond end of file produces header with no body", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "small.txt"), "only\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ViewFileTool.init()
          const result = await tool.execute(
            {
              filePath: path.join(tmp.path, "small.txt"),
              ranges: [{ offset: 100, limit: 5 }],
            },
            ctx,
          )

          // Header exists but no content body
          expect(result.output).toMatch(/^\[.*#[0-9A-F]{4}\]\n$/)
          expect(result.metadata.totalLines).toBe(1)
        },
      })
    })

    test("rejects ranges with negative offset", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "f.txt"), "data\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ViewFileTool.init()
          await expect(
            tool.execute(
              {
                filePath: path.join(tmp.path, "f.txt"),
                ranges: [{ offset: -1, limit: 3 }],
              },
              ctx,
            ),
          ).rejects.toThrow()
        },
      })
    })

    test("rejects ranges with negative limit", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "f.txt"), "data\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ViewFileTool.init()
          await expect(
            tool.execute(
              {
                filePath: path.join(tmp.path, "f.txt"),
                ranges: [{ offset: 0, limit: -1 }],
              },
              ctx,
            ),
          ).rejects.toThrow()
        },
      })
    })
  })

  describe("conflict detection integration", () => {
    test("returns conflict metadata when viewing a file with git conflict markers", async () => {
      // eslint-disable-next-line no-irregular-whitespace
      const content = `before
<<<<<<< HEAD
ours
=======
theirs
>>>>>>> main
after
`
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "conflict.txt"), content)
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ViewFileTool.init()
          const result = await tool.execute({ filePath: path.join(tmp.path, "conflict.txt") }, ctx)

          // Metadata reports conflicts
          expect(result.metadata.hasConflicts).toBe(true)
          expect(result.metadata.conflicts).toHaveLength(1)
          expect(result.metadata.conflicts[0].startLine).toBe(2)
          expect(result.metadata.conflicts[0].separatorLine).toBe(4)
          expect(result.metadata.conflicts[0].endLine).toBe(6)

          // Output contains a warning about unresolved conflicts
          expect(result.output).toMatch(/conflict|unresolved/i)
        },
      })
    })

    test("returns hasConflicts false for clean files", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "clean.txt"), "clean content\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ViewFileTool.init()
          const result = await tool.execute({ filePath: path.join(tmp.path, "clean.txt") }, ctx)

          expect(result.metadata.hasConflicts).toBe(false)
        },
      })
    })
  })
})
