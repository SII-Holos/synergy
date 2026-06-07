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
})
