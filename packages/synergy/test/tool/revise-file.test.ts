import { describe, expect, test } from "bun:test"
import path from "path"
import { ReviseFileTool } from "../../src/tool/revise-file"
import { Instance } from "../../src/scope/instance"
import { tmpdir } from "../fixture/fixture"
import { computeTag } from "../../src/hashline/tag"

const ctx = {
  sessionID: "test-hashline-revise",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

// Git conflict test fixture
const CONFLICT_CONTENT_1 = "header\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\nfooter\n"
const CONFLICT_CONTENT_2 = "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n"

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
            /input must begin|must begin with|Invalid patch/,
          )
        },
      })
    })

    test("rejects input with unknown tag header", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "src/a.ts"), "content\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ReviseFileTool.init()
          await expect(tool.execute({ input: "[src/a.ts#A1B2]\nrename foo:\n" }, ctx)).rejects.toThrow(
            /header|out-of-date|unknown|current/,
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
          const badPatch = "[file.ts#FFFF]\nreplace 1..1:\n+new\n"
          await expect(tool.execute({ input: badPatch }, ctx)).rejects.toThrow(/header|tag|out-of-date|current/)
        },
      })
    })

    test("rejects patch when stored content does not match tag", async () => {
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

          expect(result.output).toMatch(/^\[file\.ts#[0-9A-F]{4}\]\n/)
          expect(result.metadata.applied).toBe(true)
          expect(result.metadata.tag).toMatch(/^[0-9A-F]{4}$/)

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
          const patchInput = `[file.ts#${tag}]\nINS.PRE 2:\n+inserted here\n`
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
          const patchInput = `[file.ts#${tag}]\nINS.POST 2:\n+after line 2\n`
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
          const patchInput = `[file.ts#${tag}]\nINS.HEAD:\n+#!/usr/bin/env node\n`
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
          const patchInput = `[file.ts#${tag}]\nINS.TAIL:\n+// EOF\n`
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
          expect(result.output).toMatch(/^\[file\.ts#[0-9A-F]{4}\]\n/)
          expect(result.output).toContain("1:const x = 2")
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
          expect(result.output).toContain("no change")
          expect(result.output).toContain("re-read")
        },
      })
    })

    test("provides a clear error for missing tag", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ReviseFileTool.init()
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

  describe("conflict rejection", () => {
    test("refuses to edit file containing git conflict markers", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "conflict.ts"), CONFLICT_CONTENT_1)
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { ViewFileTool } = await import("../../src/tool/view-file")
          const view = await ViewFileTool.init()
          const viewed = await view.execute({ filePath: path.join(tmp.path, "conflict.ts") }, ctx)
          const tag = viewed.metadata.tag as string

          const tool = await ReviseFileTool.init()
          const patchInput = `[conflict.ts#${tag}]\nreplace 2..2:\n+clean header\n`

          await expect(tool.execute({ input: patchInput }, ctx)).rejects.toThrow(/conflict|unresolved|marker/i)

          const onDisk = await Bun.file(path.join(tmp.path, "conflict.ts")).text()
          expect(onDisk).toBe(CONFLICT_CONTENT_1)
        },
      })
    })

    test("refuses to edit file even with a valid tag when conflicts are present", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "f.ts"), CONFLICT_CONTENT_2)
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { ViewFileTool } = await import("../../src/tool/view-file")
          const view = await ViewFileTool.init()
          const viewed = await view.execute({ filePath: path.join(tmp.path, "f.ts") }, ctx)
          const tag = viewed.metadata.tag as string

          const tool = await ReviseFileTool.init()
          const patchInput = `[f.ts#${tag}]\nreplace 1..1:\n+clean\n`

          await expect(tool.execute({ input: patchInput }, ctx)).rejects.toThrow(/conflict|unresolved/i)
        },
      })
    })

    test("does not reject edits for clean files without conflict markers", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "clean.ts"), "const x = 1\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { ViewFileTool } = await import("../../src/tool/view-file")
          const view = await ViewFileTool.init()
          const viewed = await view.execute({ filePath: path.join(tmp.path, "clean.ts") }, ctx)
          const tag = viewed.metadata.tag as string

          const tool = await ReviseFileTool.init()
          const patchInput = `[clean.ts#${tag}]\nreplace 1..1:\n+const x = 2\n`
          const result = await tool.execute({ input: patchInput }, ctx)

          expect(result.metadata.applied).toBe(true)
        },
      })
    })
  })

  describe("diagnostics metadata", () => {
    test("returns diagnostics in metadata after revise", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "mod.ts"), "const x = 1\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { ViewFileTool } = await import("../../src/tool/view-file")
          const view = await ViewFileTool.init()
          const viewed = await view.execute({ filePath: path.join(tmp.path, "mod.ts") }, ctx)
          const tag = viewed.metadata.tag as string

          const tool = await ReviseFileTool.init()
          const result = await tool.execute({ input: `[mod.ts#${tag}]\nreplace 1..1:\n+const x = 2\n` }, ctx)

          expect(result.metadata).toHaveProperty("diagnostics")
          const d = (result.metadata as any).diagnostics
          expect(d).not.toBeNull()
          expect(typeof d).toBe("object")
        },
      })
    })

    test("diagnostics is present in metadata even for no-op revise", async () => {
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
          expect(result.metadata).toHaveProperty("diagnostics")
        },
      })
    })
  })

  describe("format-aware metadata", () => {
    const formatAwareCtx = (sessionID: string) => ({
      sessionID,
      messageID: "",
      callID: "",
      agent: "test-strategist",
      abort: AbortSignal.any([]),
      metadata: () => {},
      ask: async () => {},
    })

    test("returned tag matches final on-disk content after formatting", async () => {
      const sessID = "test-revise-fmt-tag"
      await using tmp = await tmpdir({
        git: true,
        config: {
          formatter: {
            "test-fmt": {
              command: ["bun", "run", "fmt-collapse.js", "$FILE"],
              extensions: [".ts"],
            },
          },
        },
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "fmt-collapse.js"),
            "import { readFileSync, writeFileSync } from 'fs'\nconst p = process.argv[2]\nconst c = readFileSync(p, 'utf8')\nwriteFileSync(p, c.replace(/ {2,}/g, ' '))\n",
          )
          await Bun.write(path.join(dir, "fmt.ts"), "const  x  =  1\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { Format } = await import("../../src/file/format")
          Format.init()

          const { ViewFileTool } = await import("../../src/tool/view-file")
          const view = await ViewFileTool.init()
          const viewed = await view.execute({ filePath: path.join(tmp.path, "fmt.ts") }, formatAwareCtx(sessID))
          const tag = viewed.metadata.tag as string

          const tool = await ReviseFileTool.init()
          const patch = `[fmt.ts#${tag}]\nreplace 1..1:\n+const  y  =  2\n`
          const result = await tool.execute({ input: patch }, formatAwareCtx(sessID))

          const onDisk = await Bun.file(path.join(tmp.path, "fmt.ts")).text()
          // After formatting, stored tag and metadata tag should match
          const storedTag = computeTag(onDisk)
          expect(result.metadata.tag).toBe(storedTag)
        },
      })
    })

    test("returned filediff.after matches final on-disk content after formatting", async () => {
      const sessID = "test-revise-fmt-filediff"
      await using tmp = await tmpdir({
        git: true,
        config: {
          formatter: {
            "test-fmt": {
              command: ["bun", "run", "fmt-collapse.js", "$FILE"],
              extensions: [".ts"],
            },
          },
        },
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "fmt-collapse.js"),
            "import { readFileSync, writeFileSync } from 'fs'\nconst p = process.argv[2]\nconst c = readFileSync(p, 'utf8')\nwriteFileSync(p, c.replace(/ {2,}/g, ' '))\n",
          )
          await Bun.write(path.join(dir, "fmt2.ts"), "const  a  =  1\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { Format } = await import("../../src/file/format")
          Format.init()

          const { ViewFileTool } = await import("../../src/tool/view-file")
          const view = await ViewFileTool.init()
          const viewed = await view.execute({ filePath: path.join(tmp.path, "fmt2.ts") }, formatAwareCtx(sessID))
          const tag = viewed.metadata.tag as string

          const tool = await ReviseFileTool.init()
          const patch = `[fmt2.ts#${tag}]\nreplace 1..1:\n+const  b  =  3\n`
          const result = await tool.execute({ input: patch }, formatAwareCtx(sessID))

          const onDisk = await Bun.file(path.join(tmp.path, "fmt2.ts")).text()
          expect(result.metadata.filediff.after).toBe(onDisk)
        },
      })
    })
  })
})
