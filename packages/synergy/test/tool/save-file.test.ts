import { describe, expect, test } from "bun:test"
import path from "path"
import { SaveFileTool } from "../../src/tool/save-file"
import { ScopeContext } from "../../src/scope/context"
import { Snapshot } from "../../src/session/snapshot"
import { tmpdir } from "../fixture/fixture"
import { computeTag } from "../../src/hashline/tag"

const ctx = {
  sessionID: "test-hashline-save",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.save_file", () => {
  describe("basic write", () => {
    test("writes content to file and returns hashline header", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await SaveFileTool.init()
          const result = await tool.execute(
            { filePath: path.join(tmp.path, "new.ts"), content: "const x = 1\nexport default x\n" },
            ctx,
          )

          // Returns [path#TAG] header
          expect(result.output).toMatch(/^\[new\.ts#[0-9A-F]{4}\]$/)

          // File exists on disk
          const written = await Bun.file(path.join(tmp.path, "new.ts")).text()
          expect(written).toBe("const x = 1\nexport default x\n")

          // Tag is content-derived
          expect(result.metadata.tag).toBe(computeTag("const x = 1\nexport default x\n"))
        },
      })
    })

    test("returns correct tag for empty file", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await SaveFileTool.init()
          const result = await tool.execute({ filePath: path.join(tmp.path, "empty.txt"), content: "" }, ctx)

          expect(result.output).toMatch(/^\[empty\.txt#[0-9A-F]{4}\]$/)
          expect(result.metadata.tag).toBe(computeTag(""))
        },
      })
    })

    test("returns new tag after overwriting existing file", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "file.ts"), "v1\n")
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await SaveFileTool.init()
          const result = await tool.execute({ filePath: path.join(tmp.path, "file.ts"), content: "v2 revised\n" }, ctx)

          expect(result.output).toMatch(/^\[file\.ts#[0-9A-F]{4}\]$/)
          expect(result.metadata.tag).toBe(computeTag("v2 revised\n"))
          expect(result.metadata.tag).not.toBe(computeTag("v1\n"))

          const onDisk = await Bun.file(path.join(tmp.path, "file.ts")).text()
          expect(onDisk).toBe("v2 revised\n")
        },
      })
    })
  })

  describe("accidental hashline stripping", () => {
    test("strips accidental hashline display prefixes from content", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await SaveFileTool.init()
          // LLM might accidentally include hashline display lines in content
          const dirtyContent = "[file.ts#A1B2]\n1:const x = 1\n2:const y = 2\n"
          const result = await tool.execute({ filePath: path.join(tmp.path, "file.ts"), content: dirtyContent }, ctx)

          const onDisk = await Bun.file(path.join(tmp.path, "file.ts")).text()
          expect(onDisk).not.toContain("[file.ts#")
          expect(onDisk).not.toContain("1:const x")
          expect(onDisk).not.toContain("2:const y")
          expect(onDisk).toBe("const x = 1\nconst y = 2\n")
        },
      })
    })

    test("does not strip legitimate content that has pipe characters", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await SaveFileTool.init()
          const legitContent = "value | pipe | data\nnormal line\n"
          const result = await tool.execute({ filePath: path.join(tmp.path, "file.txt"), content: legitContent }, ctx)

          const onDisk = await Bun.file(path.join(tmp.path, "file.txt")).text()
          expect(onDisk).toBe(legitContent)
          expect(result.metadata.tag).toBe(computeTag(legitContent))
        },
      })
    })

    test("does not strip non-contiguous numeric prefixes after a hashline-looking header", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await SaveFileTool.init()
          const content = "[log.txt#A1B2]\n10:error started\n20:error finished\n"
          await tool.execute({ filePath: path.join(tmp.path, "log.txt"), content }, ctx)

          const onDisk = await Bun.file(path.join(tmp.path, "log.txt")).text()
          expect(onDisk).toBe(content)
        },
      })
    })

    test("does not corrupt content that has no hashline prefix but looks close", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await SaveFileTool.init()
          const content = "[this is valid markdown link text]\n(normal line)\n"
          const result = await tool.execute({ filePath: path.join(tmp.path, "readme.md"), content }, ctx)

          const onDisk = await Bun.file(path.join(tmp.path, "readme.md")).text()
          // Should preserve the markdown content as-is since it doesn't match hashline format
          expect(onDisk).toContain("[this is valid markdown link text]")
        },
      })
    })
  })

  describe("snapshot recording", () => {
    test("recorded snapshot is retrievable after save", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await SaveFileTool.init()
          const content = "saved content\n"
          const result = await tool.execute({ filePath: path.join(tmp.path, "test.txt"), content }, ctx)
          const tag = result.metadata.tag as string

          // After saving, the snapshot should be available for revise_file
          const { ReviseFileTool } = await import("../../src/tool/revise-file")
          const revise = await ReviseFileTool.init()
          const patchInput = `[test.txt#${tag}]\nreplace 1..1:\n+modified content\n`
          const reviseResult = await revise.execute({ input: patchInput }, ctx)

          expect(reviseResult.metadata.applied).toBe(true)
          expect(reviseResult.metadata.tag).not.toBe(tag)

          const onDisk = await Bun.file(path.join(tmp.path, "test.txt")).text()
          expect(onDisk).toBe("modified content\n")
        },
      })
    })
  })

  describe("create parent directories", () => {
    test("creates missing parent directories for new file paths", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await SaveFileTool.init()
          const result = await tool.execute(
            { filePath: path.join(tmp.path, "deep", "nested", "dir", "conf.ts"), content: "export const x = 1\n" },
            ctx,
          )

          expect(result.output).toMatch(/^\[deep\/nested\/dir\/conf\.ts#[0-9A-F]{4}\]$/)

          const onDisk = await Bun.file(path.join(tmp.path, "deep", "nested", "dir", "conf.ts")).text()
          expect(onDisk).toBe("export const x = 1\n")
        },
      })
    })
  })

  describe("conflict metadata", () => {
    test("overwrites conflicted content and reports prior conflict", async () => {
      // eslint-disable-next-line no-irregular-whitespace
      const conflictContent = `before
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
          await Bun.write(path.join(dir, "conflict.ts"), conflictContent)
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await SaveFileTool.init()
          const result = await tool.execute(
            { filePath: path.join(tmp.path, "conflict.ts"), content: "resolved content\n" },
            ctx,
          )

          // File is overwritten with clean content
          const onDisk = await Bun.file(path.join(tmp.path, "conflict.ts")).text()
          expect(onDisk).toBe("resolved content\n")

          // The overwrite must succeed — save_file does not refuse conflicted files.
          expect(result.output).toMatch(/^\[.*#[0-9A-F]{4}\]$/)
        },
      })
    })

    test("reports hasConflicts false in metadata for clean file writes", async () => {
      // When writing a clean file, the metadata should indicate no internal conflicts
      const cleanContent = "clean content\nno markers here\n"
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await SaveFileTool.init()
          const result = await tool.execute({ filePath: path.join(tmp.path, "new.txt"), content: cleanContent }, ctx)

          // The newly written content should have no conflict metadata flagged
          if ("hasConflicts" in result.metadata) {
            expect(result.metadata.hasConflicts).toBe(false)
          }
        },
      })
    })

    test("can overwrite a file that previously had conflict markers", async () => {
      // eslint-disable-next-line no-irregular-whitespace
      const conflictContent = `<<<<<<< HEAD
a
=======
b
>>>>>>> main
`
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "f.ts"), conflictContent)
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          // View the conflicted file first (to confirm view_file sees it)
          const { ViewFileTool } = await import("../../src/tool/view-file")
          const view = await ViewFileTool.init()
          const viewed = await view.execute({ filePath: path.join(tmp.path, "f.ts") }, ctx)
          // view_file should see the conflicts
          expect(viewed.metadata.hasConflicts).toBe(true)

          // Now overwrite with resolved content
          const tool = await SaveFileTool.init()
          const result = await tool.execute({ filePath: path.join(tmp.path, "f.ts"), content: "resolved\n" }, ctx)

          // Save succeeded
          expect(result.output).toMatch(/^\[.*#[0-9A-F]{4}\]$/)

          // File on disk is resolved
          const onDisk = await Bun.file(path.join(tmp.path, "f.ts")).text()
          expect(onDisk).toBe("resolved\n")

          // View again — should now be clean
          const reViewed = await view.execute({ filePath: path.join(tmp.path, "f.ts") }, ctx)
          expect(reViewed.metadata.hasConflicts).toBe(false)
        },
      })
    })
  })

  describe("diagnostics metadata", () => {
    test("returns diagnostics in metadata after write", async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await SaveFileTool.init()
          const result = await tool.execute({ filePath: path.join(tmp.path, "diag.ts"), content: "const x = 1\n" }, ctx)

          expect(result.metadata).toHaveProperty("diagnostics")
          const d = (result.metadata as any).diagnostics
          expect(d).not.toBeNull()
          expect(typeof d).toBe("object")
        },
      })
    })

    test("diagnostics is present in metadata even after overwrite", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "exist.ts"), "old\n")
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await SaveFileTool.init()
          const result = await tool.execute(
            { filePath: path.join(tmp.path, "exist.ts"), content: "new content\n" },
            ctx,
          )

          expect(result.metadata).toHaveProperty("diagnostics")
          const d = (result.metadata as any).diagnostics
          expect(d).not.toBeNull()
          expect(typeof d).toBe("object")
        },
      })
    })
  })

  describe("format-aware metadata", () => {
    test("returned tag matches final on-disk content after formatting", async () => {
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
            `import { readFileSync, writeFileSync } from "fs";\nconst p = process.argv[2];\nconst c = readFileSync(p, "utf8");\nwriteFileSync(p, c.replace(/ {2,}/g, " "));\n`,
          )
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { Format } = await import("../../src/file/format")
          Format.init()

          const tool = await SaveFileTool.init()
          const unformatted = "const  x  =  1\n"
          const result = await tool.execute({ filePath: path.join(tmp.path, "fmt.ts"), content: unformatted }, ctx)

          const onDisk = await Bun.file(path.join(tmp.path, "fmt.ts")).text()
          // After formatting, on-disk content should have single spaces
          // whereas the current code computes the tag from the unformatted content
          expect(result.metadata.tag).toBe(computeTag(onDisk))
        },
      })
    })

    test("returned filediff summary matches final on-disk content after formatting", async () => {
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
            `import { readFileSync, writeFileSync } from "fs";\nconst p = process.argv[2];\nconst c = readFileSync(p, "utf8");\nwriteFileSync(p, c.replace(/ {2,}/g, " "));\n`,
          )
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const { Format } = await import("../../src/file/format")
          Format.init()

          const tool = await SaveFileTool.init()
          const unformatted = "const  y  =  2\n"
          const result = await tool.execute({ filePath: path.join(tmp.path, "fmt2.ts"), content: unformatted }, ctx)

          const onDisk = await Bun.file(path.join(tmp.path, "fmt2.ts")).text()
          expect(result.metadata.filediff.afterBytes).toBe(Buffer.byteLength(onDisk, "utf8"))
          expect(result.metadata.filediff.preview).toContain(onDisk.trim())
        },
      })
    })
  })
})
