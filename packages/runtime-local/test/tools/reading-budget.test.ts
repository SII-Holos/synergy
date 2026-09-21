import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ReadTool } from "../../src/tools/read"
import { ViewFileTool } from "../../src/tools/view-file"
import { SessionHashlineStore } from "../../src/hashline/store"
import { ScanFilesTool } from "../../src/tools/scan-files"
import { ReviseFileTool } from "../../src/tools/revise-file"

const ctx = {
  sessionID: "reading-budget",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

test("classic read honors small limits and preserves complete long UTF-8 lines", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "long.txt"), `${"中文".repeat(1500)}\nsecond\nthird`)
    },
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const result = await (await ReadTool.init()).execute({ filePath: path.join(tmp.path, "long.txt"), limit: 1 }, ctx)
      expect(result.output).toContain("中文".repeat(1500))
      expect(result.output).not.toContain("second")
      expect(result.metadata.limit).toBe(1)
    },
  })
})

test("search can provide sufficient context for a direct anchored edit", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "code.ts"), "// before\nconst value = 1\n// after\n")
    },
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const result = await (
        await ScanFilesTool.init()
      ).execute({ pattern: "const value", path: tmp.path, context: 1 }, ctx)
      expect(result.output).toContain("1:// before")
      expect(result.output).toContain("3:// after")
      const tag = result.metadata.tags["code.ts"]
      await (await ReviseFileTool.init()).execute({ input: `[code.ts#${tag}]\nSWAP 2.=2:\n+const value = 2` }, ctx)
      expect(await Bun.file(path.join(tmp.path, "code.ts")).text()).toContain("value = 2")
    },
  })
})

test("a sparse edit returns a compact preview and preserves known lines for another edit", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "large.txt"), Array.from({ length: 1000 }, (_, i) => `row ${i + 1}`).join("\n"))
    },
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const filePath = path.join(tmp.path, "large.txt")
      const view = await (await ViewFileTool.init()).execute({ filePath }, ctx)
      const revise = await ReviseFileTool.init()
      const result = await revise.execute({ input: `[large.txt#${view.metadata.tag}]\nSWAP 500.=500:\n+changed` }, ctx)
      expect(result.output).toContain("500:changed")
      expect(result.output).not.toContain("1:row 1\n")
      expect(result.output.length).toBeLessThan(1500)
      await revise.execute({ input: `[large.txt#${result.metadata.tag}]\nSWAP 800.=800:\n+second change` }, ctx)
      expect(await Bun.file(filePath).text()).toContain("second change")
    },
  })
})

test("ranges share a UTF-8 budget, deduplicate rows and record only complete displayed lines", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "wide.txt"),
        Array.from({ length: 100 }, (_, i) => `${i} ${"中".repeat(900)}`).join("\n"),
      )
    },
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const filePath = path.join(tmp.path, "wide.txt")
      const result = await (
        await ViewFileTool.init()
      ).execute(
        {
          filePath,
          ranges: [
            { offset: 0, limit: 15 },
            { offset: 5, limit: 50 },
          ],
        },
        ctx,
      )
      const rows = result.output.split("\n").filter((line) => /^\d+:/.test(line))
      expect(Buffer.byteLength(rows.join("\n"))).toBeLessThanOrEqual(50 * 1024)
      expect(rows.length).toBeLessThan(25)
      expect(rows.every((line) => line.endsWith("中".repeat(900)))).toBe(true)
      const numbers = rows.map((line) => Number(line.split(":")[0]))
      expect(new Set(numbers).size).toBe(numbers.length)
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("offset=")
      expect(
        [...SessionHashlineStore.get(ctx.sessionID).byHash(filePath, result.metadata.tag!)!.seenLines!].sort(
          (a, b) => a - b,
        ),
      ).toEqual([...numbers].sort((a, b) => a - b))
    },
  })
})

test("oversized rows do not promise a non-progressing read and cannot authorize edits", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "huge.txt"), "中".repeat(20000) + "\ntail")
    },
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const filePath = path.join(tmp.path, "huge.txt")
      const read = await (await ReadTool.init()).execute({ filePath, limit: 1 }, ctx)
      expect(read.output).toContain("bounded shell")
      expect(read.output).not.toContain("Use offset=0 to continue")
      const view = await (await ViewFileTool.init()).execute({ filePath, limit: 1 }, ctx)
      expect(SessionHashlineStore.get(ctx.sessionID).byHash(filePath, view.metadata.tag!)?.seenLines?.size).toBe(0)
      await expect(
        (await ReviseFileTool.init()).execute({ input: `[huge.txt#${view.metadata.tag}]\nSWAP 1.=1:\n+changed` }, ctx),
      ).rejects.toThrow()
    },
  })
})

test("oversized snapshots expose only complete prefix rows and honest recovery", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "large.txt"), "first\n" + "x".repeat(5 * 1024 * 1024))
    },
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const result = await (await ViewFileTool.init()).execute({ filePath: path.join(tmp.path, "large.txt") }, ctx)
      expect(result.output).toContain("1:first")
      expect(result.output).not.toContain("2:xxx")
      expect(result.output).not.toContain("narrower view_file")
      expect(result.metadata.snapshotAvailable).toBe(false)
    },
  })
})

import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { File } from "../../src/file"
import { unlink, mkdir } from "node:fs/promises"

test("partial multi-file failure reports the successful edit without repeating it", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "a.txt"), "a\n")
      await Bun.write(path.join(dir, "b.txt"), "b\n")
    },
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const view = await ViewFileTool.init()
      const a = await view.execute({ filePath: path.join(tmp.path, "a.txt") }, ctx)
      const b = await view.execute({ filePath: path.join(tmp.path, "b.txt") }, ctx)
      const unsubscribe = Bus.subscribe(File.Event.Edited, async (e) => {
        if (e.properties.file.endsWith("a.txt")) {
          await unlink(path.join(tmp.path, "b.txt"))
          await mkdir(path.join(tmp.path, "b.txt"))
        }
      })
      try {
        const result = await (
          await ReviseFileTool.init()
        ).execute(
          {
            input: `[a.txt#${a.metadata.tag}]\nSWAP 1.=1:\n+changed a\n[b.txt#${b.metadata.tag}]\nSWAP 1.=1:\n+changed b`,
          },
          ctx,
        )
        expect(result.metadata.applied).toBe(true)
        expect(result.metadata.sections).toHaveLength(1)
        expect(result.output).toContain("Partial failure: 1/2")
        expect(await Bun.file(path.join(tmp.path, "a.txt")).text()).toContain("changed a")
      } finally {
        unsubscribe()
      }
    },
  })
})

test("post-write verification failure retains truthful write status and invalidates its tag", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Bun.write(path.join(dir, "a.txt"), "a\n")
    },
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const filePath = path.join(tmp.path, "a.txt")
      const a = await (await ViewFileTool.init()).execute({ filePath }, ctx)
      const unsubscribe = Bus.subscribe(File.Event.Edited, async () => {
        await unlink(filePath)
      })
      try {
        const result = await (
          await ReviseFileTool.init()
        ).execute({ input: `[a.txt#${a.metadata.tag}]\nSWAP 1.=1:\n+changed a` }, ctx)
        expect(result.metadata.applied).toBe(true)
        expect(result.output).toContain("post-write verification failed")
        expect(SessionHashlineStore.get(ctx.sessionID).byHash(filePath, result.metadata.tag)).toBeNull()
      } finally {
        unsubscribe()
      }
    },
  })
})
