import { describe, expect, test } from "bun:test"
import path from "path"
import { GlobTool } from "@ericsanchezok/synergy-local-runtime/tools/glob"
import { ListTool } from "@ericsanchezok/synergy-local-runtime/tools/ls"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const ctx = {
  sessionID: "test-glob-ls",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

function abortedCtx() {
  const controller = new AbortController()
  controller.abort()
  return { ...ctx, abort: controller.signal }
}

describe("tool.glob", () => {
  test("finds files matching pattern in a small directory", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "a.ts"), "// a\n")
          await Bun.write(path.join(dir, "b.ts"), "// b\n")
          await Bun.write(path.join(dir, "c.txt"), "c\n")
          await Bun.write(path.join(dir, "d.md"), "d\n")
        },
      })

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await GlobTool.init()
          const result = await tool.execute({ pattern: "*.ts" }, ctx)

          expect(result.metadata.truncated).toBe(false)
          expect(result.metadata.count).toBe(2)
          expect(result.output).toContain("a.ts")
          expect(result.output).toContain("b.ts")
          expect(result.output).not.toContain("c.txt")
          expect(result.output).not.toContain("d.md")
        },
      })
    }))

  test("returns empty result and not truncated when no files match", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (_dir) => {},
      })

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await GlobTool.init()
          const result = await tool.execute({ pattern: "*.zzz" }, ctx)

          expect(result.metadata.truncated).toBe(false)
          expect(result.metadata.count).toBe(0)
          expect(result.output).toContain("No files found")
        },
      })
    }))

  test("preserves cancellation instead of reporting a successful partial search", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "a.ts"), "// a\n")
          await Bun.write(path.join(dir, "b.ts"), "// b\n")
        },
      })

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await GlobTool.init()
          const context = abortedCtx()
          await expect(tool.execute({ pattern: "*.ts" }, context)).rejects.toBe(context.abort.reason)
        },
      })
    }))

  test("outputs truncation message when truncated is true via limit", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          // Create 101 files so the 100-file limit triggers truncated
          for (let i = 0; i < 101; i++) {
            await Bun.write(path.join(dir, `file_${String(i).padStart(3, "0")}.ts`), `// ${i}\n`)
          }
        },
      })

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await GlobTool.init()
          const result = await tool.execute({ pattern: "*.ts" }, ctx)

          expect(result.metadata.truncated).toBe(true)
          expect(result.metadata.count).toBe(100)
          expect(result.output).toContain("(Results are truncated.")
        },
      })
    }))
})

describe("tool.list", () => {
  test("returns directory tree for a small directory", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "a.ts"), "a\n")
          await Bun.write(path.join(dir, "b.ts"), "b\n")
        },
      })

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ListTool.init()
          const result = await tool.execute({}, ctx)

          expect(result.metadata.truncated).toBe(false)
          expect(result.metadata.count).toBeGreaterThanOrEqual(1)
          expect(result.output).toContain("a.ts")
          expect(result.output).toContain("b.ts")
        },
      })
    }))

  test("preserves cancellation instead of reporting a successful partial listing", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "a.ts"), "a\n")
        },
      })

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const tool = await ListTool.init()
          const context = abortedCtx()
          await expect(tool.execute({}, context)).rejects.toBe(context.abort.reason)
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
