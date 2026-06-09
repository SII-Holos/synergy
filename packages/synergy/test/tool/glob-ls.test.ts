import { describe, expect, test } from "bun:test"
import path from "path"
import { GlobTool } from "../../src/tool/glob"
import { ListTool } from "../../src/tool/ls"
import { Instance } from "../../src/scope/instance"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test-glob-ls",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

/**
 * Build a ctx with a pre-aborted signal. The combined signal
 * (AbortSignal.any([preAborted, timeoutSignal])) is immediately aborted,
 * so Ripgrep is killed before producing any output.
 */
function abortedCtx() {
  const controller = new AbortController()
  controller.abort()
  return { ...ctx, abort: controller.signal }
}

describe("tool.glob", () => {
  test("finds files matching pattern in a small directory", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.ts"), "// a\n")
        await Bun.write(path.join(dir, "b.ts"), "// b\n")
        await Bun.write(path.join(dir, "c.txt"), "c\n")
        await Bun.write(path.join(dir, "d.md"), "d\n")
      },
    })

    await Instance.provide({
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
  })

  test("returns empty result and not truncated when no files match", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (_dir) => {},
    })

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await GlobTool.init()
        const result = await tool.execute({ pattern: "*.zzz" }, ctx)

        expect(result.metadata.truncated).toBe(false)
        expect(result.metadata.count).toBe(0)
        expect(result.output).toContain("No files found")
      },
    })
  })

  test("returns partial results without throwing when ctx.abort is already aborted", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.ts"), "// a\n")
        await Bun.write(path.join(dir, "b.ts"), "// b\n")
      },
    })

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await GlobTool.init()
        // ctx.abort is pre-aborted — the tool must not throw
        const result = await tool.execute({ pattern: "*.ts" }, abortedCtx())

        // User abort must NOT set truncated (only timeout does)
        expect(result.metadata.truncated).toBe(false)
        // Output should exist (may be empty or partial — don't crash)
        expect(typeof result.output).toBe("string")
        expect(result.metadata.count).toBeGreaterThanOrEqual(0)
      },
    })
  })

  test("outputs truncation message when truncated is true via limit", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // Create 101 files so the 100-file limit triggers truncated
        for (let i = 0; i < 101; i++) {
          await Bun.write(path.join(dir, `file_${String(i).padStart(3, "0")}.ts`), `// ${i}\n`)
        }
      },
    })

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await GlobTool.init()
        const result = await tool.execute({ pattern: "*.ts" }, ctx)

        expect(result.metadata.truncated).toBe(true)
        expect(result.metadata.count).toBe(100)
        expect(result.output).toContain("(Results are truncated.")
      },
    })
  })
})

describe("tool.list", () => {
  test("returns directory tree for a small directory", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.ts"), "a\n")
        await Bun.write(path.join(dir, "b.ts"), "b\n")
      },
    })

    await Instance.provide({
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
  })

  test("returns partial results without throwing when ctx.abort is already aborted", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.ts"), "a\n")
      },
    })

    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await ListTool.init()
        // ctx.abort is pre-aborted — the tool must not throw
        const result = await tool.execute({}, abortedCtx())

        // User abort must NOT set truncated (only timeout does)
        expect(result.metadata.truncated).toBe(false)
        expect(typeof result.output).toBe("string")
        expect(result.metadata.count).toBeGreaterThanOrEqual(0)
      },
    })
  })
})
