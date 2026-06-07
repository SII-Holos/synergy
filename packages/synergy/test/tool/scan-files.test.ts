import { describe, expect, test } from "bun:test"
import path from "path"
import { ScanFilesTool } from "../../src/tool/scan-files"
import { Instance } from "../../src/scope/instance"
import { tmpdir } from "../fixture/fixture"
import { computeTag } from "../../src/hashline/tag"

const ctx = {
  sessionID: "test-hashline-scan",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.scan_files", () => {
  describe("regex search with hashline output", () => {
    test("groups results by file with hashline headers", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "a.ts"), "export const a = 1\nexport const b = 2\n")
          await Bun.write(path.join(dir, "b.ts"), "const c = 3\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ScanFilesTool.init()
          const result = await tool.execute({ pattern: "export", path: tmp.path, include: "*.ts" }, ctx)

          // Should have hashline headers for matching files
          expect(result.output).toMatch(/Matches in \[a\.ts#[0-9A-F]{4}\]: 1, 2/)
          // Should contain the matching lines in LINE:TEXT format
          expect(result.output).toMatch(/1:export const a/)
          expect(result.output).toMatch(/2:export const b/)
          expect(result.metadata.matchLines["a.ts"]).toEqual([1, 2])
        },
      })
    })

    test("does not include non-matching files", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
          await Bun.write(path.join(dir, "b.ts"), "const b = 2\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ScanFilesTool.init()
          const result = await tool.execute({ pattern: "export", path: tmp.path, include: "*.ts" }, ctx)

          expect(result.output).toContain("a.ts")
          expect(result.output).not.toContain("b.ts")
        },
      })
    })

    test("returns no matches result with hashline format", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "a.ts"), "const a = 1\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ScanFilesTool.init()
          const result = await tool.execute({ pattern: "xyznonexistentpatternxyz", path: tmp.path }, ctx)

          expect(result.metadata.matches).toBe(0)
          expect(result.output).not.toMatch(/\[.*#[0-9A-F]{4}\]/)
        },
      })
    })

    test("each matched file gets its own hashline block with full file snapshot", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "imports.ts"),
            "import { foo } from './foo'\nimport { bar } from './bar'\nexport default foo\n",
          )
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ScanFilesTool.init()
          const result = await tool.execute({ pattern: "import", path: tmp.path, globs: ["*.ts"] }, ctx)

          // Full file snapshot in hashline format
          expect(result.output).toContain("1:import { foo }")
          expect(result.output).toContain("2:import { bar }")
          expect(result.output).toContain("3:export default foo")

          // Tag in header should match full file content
          const content = "import { foo } from './foo'\nimport { bar } from './bar'\nexport default foo\n"
          const expectedTag = computeTag(content)
          expect(result.output).toContain(`[imports.ts#${expectedTag}]`)
        },
      })
    })

    test("tag is content-derived for scanned files", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "data.txt"), "hello world\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ScanFilesTool.init()
          const result = await tool.execute({ pattern: "hello", path: tmp.path }, ctx)

          expect(result.output).toContain(`[data.txt#${computeTag("hello world\n")}]`)
        },
      })
    })
  })

  describe("multiple file results", () => {
    test("separates results from different files", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
          await Bun.write(path.join(dir, "b.ts"), "export const b = 2\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ScanFilesTool.init()
          const result = await tool.execute({ pattern: "export", path: tmp.path, include: "*.ts" }, ctx)

          expect(result.metadata.matches).toBeGreaterThanOrEqual(2)
          expect(result.output).toMatch(/\[a\.ts#[A-F0-9]{4}\]/)
          expect(result.output).toMatch(/\[b\.ts#[A-F0-9]{4}\]/)
        },
      })
    })
  })

  describe("context lines", () => {
    test("includes context lines around matches", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "code.ts"),
            ["function foo() {", "  const x = helper()", "  return x", "}"].join("\n") + "\n",
          )
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ScanFilesTool.init()
          const result = await tool.execute({ pattern: "helper", path: tmp.path }, ctx)

          // Should still be a full-file snapshot, not just context
          expect(result.output).toContain("1:")
          expect(result.output).toContain("2:")
        },
      })
    })
  })

  describe("metadata", () => {
    test("metadata includes match count and file list", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "x.ts"), "export const x = 1\nimport y from 'y'\n")
        },
      })
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ScanFilesTool.init()
          const result = await tool.execute({ pattern: "import|export", path: tmp.path }, ctx)

          expect(result.metadata.matches).toBeGreaterThanOrEqual(2)
          expect(result.metadata.files).toContain("x.ts")
          expect(result.metadata.matchLines["x.ts"]).toEqual([1, 2])
        },
      })
    })
  })
})
