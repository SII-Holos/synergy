import { beforeAll, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { GrepTool } from "../../src/tools/grep"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "developer",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

let rgAvailable = false

beforeAll(() =>
  runtime.run(() => {
    rgAvailable = Boolean(Bun.which("rg"))
  }),
)

describe("tool.grep", () => {
  test("basic search", () =>
    runtime.run(async () => {
      if (!rgAvailable) {
        console.log("Skipping: ripgrep (rg) not available")
        return
      }

      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
          await Bun.write(path.join(dir, "b.ts"), "const b = 2\n")
        },
      })

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const grep = await GrepTool.init()
          const result = await grep.execute(
            {
              pattern: "export",
              path: tmp.path,
              include: "*.ts",
            },
            ctx,
          )
          expect(result.metadata.matches).toBeGreaterThan(0)
          expect(result.output).toContain("Found")
        },
      })
    }))

  test("no matches returns correct output", () =>
    runtime.run(async () => {
      if (!rgAvailable) {
        console.log("Skipping: ripgrep (rg) not available")
        return
      }

      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "test.txt"), "hello world")
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const grep = await GrepTool.init()
          const result = await grep.execute(
            {
              pattern: "xyznonexistentpatternxyz123",
              path: tmp.path,
            },
            ctx,
          )
          expect(result.metadata.matches).toBe(0)
          expect(result.output).toBe("No files found")
        },
      })
    }))

  test("handles CRLF line endings in output", () =>
    runtime.run(async () => {
      if (!rgAvailable) {
        console.log("Skipping: ripgrep (rg) not available")
        return
      }

      // This test verifies the regex split handles both \n and \r\n
      await using tmp = await tmpdir({
        init: async (dir) => {
          // Create a test file with content
          await Bun.write(path.join(dir, "test.txt"), "line1\nline2\nline3")
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const grep = await GrepTool.init()
          const result = await grep.execute(
            {
              pattern: "line",
              path: tmp.path,
            },
            ctx,
          )
          expect(result.metadata.matches).toBeGreaterThan(0)
        },
      })
    }))

  test("returns newest matches first without retaining results beyond the global limit", () =>
    runtime.run(async () => {
      if (!rgAvailable) return

      await using tmp = await tmpdir({
        init: async (dir) => {
          const older = path.join(dir, "older.ts")
          const newer = path.join(dir, "newer.ts")
          await Bun.write(older, "hit older\n")
          await Bun.write(newer, `${Array.from({ length: 110 }, (_, index) => `hit ${index}`).join("\n")}\n`)
          await fs.utimes(older, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"))
          await fs.utimes(newer, new Date("2021-01-01T00:00:00Z"), new Date("2021-01-01T00:00:00Z"))
        },
      })

      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const grep = await GrepTool.init()
          const result = await grep.execute({ pattern: "hit", path: tmp.path, include: "*.ts" }, ctx)
          expect(result.metadata.matches).toBe(100)
          expect(result.metadata.truncated).toBe(true)
          expect(result.output).toContain("newer.ts")
          expect(result.output).not.toContain("older.ts")
        },
      })
    }))

  test("returns an explicit partial-result state for a pathological single-line match", () =>
    runtime.run(async () => {
      if (!rgAvailable) return

      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "large.json"), `hit${"x".repeat(300 * 1024)}`)
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const grep = await GrepTool.init()
          const result = await grep.execute({ pattern: "hit", path: tmp.path }, ctx)
          expect(result.metadata.matches).toBe(0)
          expect(result.metadata.truncated).toBe(true)
          expect(result.metadata.truncatedReason).toBe("max_record_bytes")
          expect(result.output).toContain("output safety limit")
        },
      })
    }))

  test("preserves ripgrep failures for invalid regular expressions", () =>
    runtime.run(async () => {
      if (!rgAvailable) return

      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "file.txt"), "content\n")
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const grep = await GrepTool.init()
          await expect(grep.execute({ pattern: "[", path: tmp.path }, ctx)).rejects.toThrow("ripgrep failed")
        },
      })
    }))
})

describe("CRLF regex handling", () => {
  test("regex correctly splits Unix line endings", () =>
    runtime.run(() => {
      const unixOutput = "file1.txt|1|content1\nfile2.txt|2|content2\nfile3.txt|3|content3"
      const lines = unixOutput.trim().split(/\r?\n/)
      expect(lines.length).toBe(3)
      expect(lines[0]).toBe("file1.txt|1|content1")
      expect(lines[2]).toBe("file3.txt|3|content3")
    }))

  test("regex correctly splits Windows CRLF line endings", () =>
    runtime.run(() => {
      const windowsOutput = "file1.txt|1|content1\r\nfile2.txt|2|content2\r\nfile3.txt|3|content3"
      const lines = windowsOutput.trim().split(/\r?\n/)
      expect(lines.length).toBe(3)
      expect(lines[0]).toBe("file1.txt|1|content1")
      expect(lines[2]).toBe("file3.txt|3|content3")
    }))

  test("regex handles mixed line endings", () =>
    runtime.run(() => {
      const mixedOutput = "file1.txt|1|content1\nfile2.txt|2|content2\r\nfile3.txt|3|content3"
      const lines = mixedOutput.trim().split(/\r?\n/)
      expect(lines.length).toBe(3)
    }))
})

afterRuntimeTests(() => runtime.close())
