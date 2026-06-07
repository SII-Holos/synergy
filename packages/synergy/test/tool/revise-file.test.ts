import { describe, expect, test } from "bun:test"
import path from "path"
import { ReviseFileTool } from "../../src/tool/revise-file"
import { Instance } from "../../src/scope/instance"
import { Snapshot } from "../../src/session/snapshot"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test-hashline-revise",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.revise_file", () => {
  describe("input parsing", () => {
    test("accepts pure hashline patch text via input param", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "file.ts"), "line 1\nline 2\nline 3\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          // First, view the file to get its tag
          const { ViewFileTool } = await import("../../src/tool/view-file")
          const view = await ViewFileTool.init()
          const viewed = await view.execute({ filePath: path.join(tmp.path, "file.ts") }, ctx)
          const tag = viewed.metadata.tag as string

          const tool = await ReviseFileTool.init()
          const patchInput = `[file.ts#${tag}]\nreplace 2..2:\n+modified line 2\n`
          const result = await tool.execute({ input: patchInput }, ctx)

          expect(result.output).toMatch(/^\[file\.ts#[0-9A-F]{4}\]\n/)
          expect(result.metadata.applied).toBe(true)
        },
      })
    })

    test("rejects input without hashline header", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ReviseFileTool.init()
          await expect(tool.execute({ input: "replace 1..1:\n+new\n" }, ctx)).rejects.toThrow(
            /hashline header|invalid patch/,
          )
        },
      })
    })

    test("rejects input with invalid operation type", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ReviseFileTool.init()
          await expect(tool.execute({ input: "[src/a.ts#A1B2]\nrename foo:\n" }, ctx)).rejects.toThrow(
            /operation|invalid|unknown/,
          )
        },
      })
    })
  })

  describe("tag validation via SnapshotStore", () => {
    test("rejects patch when tag does not match stored snapshot", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "file.ts"), "hello\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ReviseFileTool.init()
          // Use a made-up tag that doesn't correspond to any snapshot
          const badPatch = "[file.ts#FFFF]\nreplace 1..1:\n+new\n"
          await expect(tool.execute({ input: badPatch }, ctx)).rejects.toThrow(/snapshot|tag|not found|stale/)
        },
      })
    })

    test("rejects patch when stored content does not match tag", async () => {
      // Store content under a tag, then try to patch with a different content expectation
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "file.ts"), "original\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { ViewFileTool } = await import("../../src/tool/view-file")
          const view = await ViewFileTool.init()
          const viewed = await view.execute({ filePath: path.join(tmp.path, "file.ts") }, ctx)
          const tag = viewed.metadata.tag as string

          // Modify the file on disk WITHOUT re-viewing (stale tag)
          await Bun.write(path.join(tmp.path, "file.ts"), "modified content that changes the real tag\n")

          const tool = await ReviseFileTool.init()
          const patchInput = `[file.ts#${tag}]\nreplace 1..1:\n+new line\n`

          // Should reject because tag no longer matches the actual file content
          await expect(tool.execute({ input: patchInput }, ctx)).rejects.toThrow(
            /STOP|stale|outdated|tag|content mismatch/,
          )
        },
      })
    })
  })

  describe("patch application", () => {
    test("replace operation modifies file correctly", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "file.ts"), "line 1\nline 2\nline 3\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { ViewFileTool } = await import("../../src/tool/view-file")
          const view = await ViewFileTool.init()
          const viewed = await view.execute({ filePath: path.join(tmp.path, "file.ts") }, ctx)
          const tag = viewed.metadata.tag as string

          const tool = await ReviseFileTool.init()
          const patchInput = `[file.ts#${tag}]\nreplace 2..2:\n+NEW LINE 2\n`
          const result = await tool.execute({ input: patchInput }, ctx)

          // Returns new tag for the modified file
          expect(result.output).toMatch(/^\[file\.ts#[0-9A-F]{4}\]\n/)
          expect(result.metadata.applied).toBe(true)
          expect(result.metadata.tag).toMatch(/^[0-9A-F]{4}$/)

          // Verify file on disk was changed
          const content = await Bun.file(path.join(tmp.path, "file.ts")).text()
          expect(content).toBe("line 1\nNEW LINE 2\nline 3\n")
        },
      })
    })

    test("delete operation removes lines", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "file.ts"), "line 1\nline 2\nline 3\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { ViewFileTool } = await import("../../src/tool/view-file")
          const view = await ViewFileTool.init()
          const viewed = await view.execute({ filePath: path.join(tmp.path, "file.ts") }, ctx)
          const tag = viewed.metadata.tag as string

          const tool = await ReviseFileTool.init()
          const patchInput = `[file.ts#${tag}]\ndelete 2..2:\n`
          const result = await tool.execute({ input: patchInput }, ctx)

          expect(result.metadata.applied).toBe(true)

          const content = await Bun.file(path.join(tmp.path, "file.ts")).text()
          expect(content).toBe("line 1\nline 3\n")
        },
      })
    })

    test("insert before operation adds lines", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "file.ts"), "line 1\nline 2\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { ViewFileTool } = await import("../../src/tool/view-file")
          const view = await ViewFileTool.init()
          const viewed = await view.execute({ filePath: path.join(tmp.path, "file.ts") }, ctx)
          const tag = viewed.metadata.tag as string

          const tool = await ReviseFileTool.init()
          const patchInput = `[file.ts#${tag}]\ninsert 2 before:\n+inserted here\n`
          const result = await tool.execute({ input: patchInput }, ctx)

          expect(result.metadata.applied).toBe(true)

          const content = await Bun.file(path.join(tmp.path, "file.ts")).text()
          expect(content).toBe("line 1\ninserted here\nline 2\n")
        },
      })
    })

    test("insert after operation adds lines after target", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "file.ts"), "line 1\nline 2\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { ViewFileTool } = await import("../../src/tool/view-file")
          const view = await ViewFileTool.init()
          const viewed = await view.execute({ filePath: path.join(tmp.path, "file.ts") }, ctx)
          const tag = viewed.metadata.tag as string

          const tool = await ReviseFileTool.init()
          const patchInput = `[file.ts#${tag}]\ninsert 2 after:\n+after line 2\n`
          const result = await tool.execute({ input: patchInput }, ctx)

          expect(result.metadata.applied).toBe(true)

          const content = await Bun.file(path.join(tmp.path, "file.ts")).text()
          expect(content).toBe("line 1\nline 2\nafter line 2\n")
        },
      })
    })

    test("insert head operation adds at beginning", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "file.ts"), "line 1\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { ViewFileTool } = await import("../../src/tool/view-file")
          const view = await ViewFileTool.init()
          const viewed = await view.execute({ filePath: path.join(tmp.path, "file.ts") }, ctx)
          const tag = viewed.metadata.tag as string

          const tool = await ReviseFileTool.init()
          const patchInput = `[file.ts#${tag}]\ninsert head:\n+#!/usr/bin/env node\n`
          const result = await tool.execute({ input: patchInput }, ctx)

          expect(result.metadata.applied).toBe(true)

          const content = await Bun.file(path.join(tmp.path, "file.ts")).text()
          expect(content).toBe("#!/usr/bin/env node\nline 1\n")
        },
      })
    })

    test("insert tail operation adds at end", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "file.ts"), "line 1\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { ViewFileTool } = await import("../../src/tool/view-file")
          const view = await ViewFileTool.init()
          const viewed = await view.execute({ filePath: path.join(tmp.path, "file.ts") }, ctx)
          const tag = viewed.metadata.tag as string

          const tool = await ReviseFileTool.init()
          const patchInput = `[file.ts#${tag}]\ninsert tail:\n+// EOF\n`
          const result = await tool.execute({ input: patchInput }, ctx)

          expect(result.metadata.applied).toBe(true)

          const content = await Bun.file(path.join(tmp.path, "file.ts")).text()
          expect(content).toBe("line 1\n// EOF\n")
        },
      })
    })
  })

  describe("result format", () => {
    test("result starts with new hashline header after modification", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "file.ts"), "const x = 1\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { ViewFileTool } = await import("../../src/tool/view-file")
          const view = await ViewFileTool.init()
          const viewed = await view.execute({ filePath: path.join(tmp.path, "file.ts") }, ctx)
          const tag = viewed.metadata.tag as string

          const tool = await ReviseFileTool.init()
          const patchInput = `[file.ts#${tag}]\nreplace 1..1:\n+const x = 2\n`
          const result = await tool.execute({ input: patchInput }, ctx)

          // Should return a new hashline block reflecting the modified file
          expect(result.output).toMatch(/^\[file\.ts#[0-9A-F]{4}\]\n1:const x = 2$/)
          // Tag must be different from input tag
          expect(result.metadata.tag).not.toBe(tag)
        },
      })
    })
  })

  describe("error messages", () => {
    test("returns an explicit no-op warning when patch produces no change", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "same.ts"), "const x = 1\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { ViewFileTool } = await import("../../src/tool/view-file")
          const view = await ViewFileTool.init()
          const viewed = await view.execute({ filePath: path.join(tmp.path, "same.ts") }, ctx)
          const tag = viewed.metadata.tag as string

          const tool = await ReviseFileTool.init()
          const result = await tool.execute({ input: `[same.ts#${tag}]\nreplace 1..1:\n+const x = 1\n` }, ctx)
          expect(result.metadata.applied).toBe(false)
          expect(result.output).toContain("No-op")
          expect(result.output).toContain("byte-identical")
        },
      })
    })

    test("provides a clear error for missing tag", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ReviseFileTool.init()
          // Tag that was never stored
          const badPatch = "[no-such-file.ts#9999]\nreplace 1..1:\n+x\n"
          await expect(tool.execute({ input: badPatch }, ctx)).rejects.toThrow(/STOP|tag|not found|snapshot|unknown/)
        },
      })
    })

    test("provides a clear error for out-of-bounds line numbers", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "short.txt"), "only one line\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { ViewFileTool } = await import("../../src/tool/view-file")
          const view = await ViewFileTool.init()
          const viewed = await view.execute({ filePath: path.join(tmp.path, "short.txt") }, ctx)
          const tag = viewed.metadata.tag as string

          const tool = await ReviseFileTool.init()
          const badPatch = `[short.txt#${tag}]\nreplace 100..100:\n+out of bounds\n`
          await expect(tool.execute({ input: badPatch }, ctx)).rejects.toThrow(/out of bounds|beyond|line/)
        },
      })
    })
  })
})
