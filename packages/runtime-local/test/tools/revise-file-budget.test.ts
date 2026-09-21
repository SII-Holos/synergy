import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, unlink } from "node:fs/promises"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ToolLspSource } from "@ericsanchezok/synergy-harness/tool/lsp-source"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { File } from "../../src/file"
import { ReviseFileTool } from "../../src/tools/revise-file"
import { ViewFileTool } from "../../src/tools/view-file"
import { SessionHashlineStore } from "../../src/hashline/store"

const ctx = {
  sessionID: "revise-output-budget",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

for (const [message, replacement] of [
  ["中文😀".repeat(1500), "new"],
  ["diagnostic detail\n".repeat(2200), "new"],
  ["diagnostic detail\n".repeat(2200), "old"],
]) {
  test(`edit ${replacement} feedback bounds ${message.includes("😀") ? "UTF-8 bytes" : "lines"} including diagnostics`, async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => Bun.write(path.join(dir, "a.txt"), "old\n"),
    })
    const previous = ToolLspSource.get()
    const filePath = path.join(tmp.path, "a.txt")
    ToolLspSource.register({
      touchFile: async () => {},
      diagnostics: async () => ({
        [filePath]: Array.from({ length: 20 }, (_, i) => ({
          severity: 1,
          message: `${i}: ${message}`,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        })),
      }),
    })
    try {
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const view = await (await ViewFileTool.init()).execute({ filePath, limit: 1 }, ctx)
          const result = await (
            await ReviseFileTool.init()
          ).execute({ input: `[a.txt#${view.metadata.tag}]\nSWAP 1..1:\n+${replacement}` }, ctx)
          expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(50 * 1024)
          expect(result.output.split("\n").length).toBeLessThanOrEqual(2000)
          expect(result.metadata.truncated).toBe(true)
          expect(result.output).toContain(`[a.txt#${result.metadata.tag}]`)
          expect(result.metadata.applied).toBe(replacement === "new")
          if (replacement === "new") expect(result.output).toContain("Applied: +1 -1")
          expect(result.metadata.outputPath).toBeString()
          const full = await Bun.file(result.metadata.outputPath!).text()
          expect(full).toContain(`19: ${message}`)
          if (replacement === "new") expect(result.metadata.filediff.preview).toContain("new")
        },
      })
    } finally {
      ToolLspSource.register(previous)
    }
  })
}

test("an omitted preview row cannot authorize an edit and full diff remains available", async () => {
  const omitted = "中😀".repeat(9000)
  await using tmp = await tmpdir({
    git: true,
    init: (dir) => Bun.write(path.join(dir, "a.txt"), `unseen before\nold\n${omitted}\ntail\n`),
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const filePath = path.join(tmp.path, "a.txt")
      const view = await (await ViewFileTool.init()).execute({ filePath, offset: 1, limit: 1 }, ctx)
      const tool = await ReviseFileTool.init()
      const result = await tool.execute({ input: `[a.txt#${view.metadata.tag}]\nSWAP 2..2:\n+new` }, ctx)
      expect(result.metadata.truncated).toBe(true)
      expect(result.metadata.outputPath).toBeString()
      expect(result.output).not.toContain(omitted)
      expect(result.metadata.diff).toContain(omitted)
      expect(SessionHashlineStore.get(ctx.sessionID).byHash(filePath, result.metadata.tag)?.seenLines?.has(3)).toBe(
        false,
      )
      await expect(tool.execute({ input: `[a.txt#${result.metadata.tag}]\nSWAP 3..3:\n+wrong` }, ctx)).rejects.toThrow()
    },
  })
})

test("formatter output supplies the final tag without granting unseen replacement lines", async () => {
  const formatted = "unseen\n" + "😀".repeat(14000) + "\nend\n"
  await using tmp = await tmpdir({
    git: true,
    init: (dir) => Bun.write(path.join(dir, "a.txt"), "unseen\nold\nend\n"),
  })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const filePath = path.join(tmp.path, "a.txt")
      const view = await (await ViewFileTool.init()).execute({ filePath, offset: 1, limit: 1 }, ctx)
      const unsubscribe = Bus.subscribe(File.Event.Edited, () => Bun.write(filePath, formatted).then(() => {}))
      try {
        const result = await (
          await ReviseFileTool.init()
        ).execute({ input: `[a.txt#${view.metadata.tag}]\nSWAP 2..2:\n+authored` }, ctx)
        const snapshot = SessionHashlineStore.get(ctx.sessionID).byHash(filePath, result.metadata.tag)
        expect(snapshot?.text).toBe(formatted)
        expect(snapshot?.seenLines?.has(2)).toBe(false)
        expect(result.metadata.truncated).toBe(true)
        expect(result.output).toContain(`[a.txt#${result.metadata.tag}]`)
        expect(result.metadata.diff).toContain("😀".repeat(14000))
      } finally {
        unsubscribe()
      }
    },
  })
})

test("partial failure stays visible when a committed file exhausts the preview budget", async () => {
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
      const unsubscribe = Bus.subscribe(File.Event.Edited, async (event) => {
        if (!event.properties.file.endsWith("a.txt")) return
        await unlink(path.join(tmp.path, "b.txt"))
        await mkdir(path.join(tmp.path, "b.txt"))
      })
      try {
        const body = Array.from({ length: 2100 }, (_, i) => `+new ${i}`).join("\n")
        const result = await (
          await ReviseFileTool.init()
        ).execute(
          {
            input: `[a.txt#${a.metadata.tag}]\nSWAP 1..1:\n${body}\n[b.txt#${b.metadata.tag}]\nSWAP 1..1:\n+changed b`,
          },
          ctx,
        )
        expect(result.output.split("\n").length).toBeLessThanOrEqual(2000)
        expect(result.output).toContain("Partial failure: 1/2")
        expect(result.output).toContain("do not repeat")
        expect(result.output).toContain(`[a.txt#${result.metadata.tag}]`)
        expect(result.metadata.sections).toHaveLength(1)
      } finally {
        unsubscribe()
      }
    },
  })
})
