import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { FileTime } from "@ericsanchezok/synergy-harness/file/time"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { EditTool } from "../../src/tools/edit"
import { ReadTool } from "../../src/tools/read"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())
function context(sessionID: string, ask: Tool.Context["ask"] = async () => {}): Tool.Context {
  return {
    sessionID,
    agent: "synergy",
    messageID: "message",
    callID: "call",
    abort: new AbortController().signal,
    metadata() {},
    ask,
  }
}

test("text edits preserve a UTF-8 BOM and an empty oldString cannot overwrite an existing file", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "bom.txt")
        await Bun.write(filePath, "\ufefforiginal\n")
        const ctx = context("bom-reader")
        await (await ReadTool.init()).execute({ filePath }, ctx)
        const edit = await EditTool.init()
        await edit.execute({ filePath, oldString: "original", newString: "changed" }, ctx)
        expect(await Bun.file(filePath).bytes()).toEqual(Buffer.from("\ufeffchanged\n"))
        await expect(edit.execute({ filePath, oldString: "", newString: "overwrite" }, ctx)).rejects.toThrow("changed")
        expect(await Bun.file(filePath).bytes()).toEqual(Buffer.from("\ufeffchanged\n"))
      },
    })
  }))

test("content changed with its old timestamp cannot pass read-before-write validation", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "same.txt")
        await Bun.write(filePath, "original\n")
        const before = await fs.stat(filePath)
        const ctx = context("reader")
        await (await ReadTool.init()).execute({ filePath }, ctx)
        await Bun.write(filePath, "external\n")
        await fs.utimes(filePath, before.atime, before.mtime)
        await expect(
          (await EditTool.init()).execute({ filePath, oldString: "external", newString: "changed" }, ctx),
        ).rejects.toThrow("modified")
        expect(await Bun.file(filePath).text()).toBe("external\n")
      },
    })
  }))

test("a cancelled waiter cannot allow another writer to bypass the active file lock", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "locked.txt")
        const entered = Promise.withResolvers<void>()
        const exit = Promise.withResolvers<void>()
        const owner = FileTime.withLock(filePath, async () => {
          entered.resolve()
          await exit.promise
        })
        await entered.promise
        const cancel = new AbortController()
        const cancelled = FileTime.withLock(
          filePath,
          async () => {
            throw new Error("Cancelled writer ran")
          },
          { signal: cancel.signal },
        )
        cancel.abort()
        await expect(cancelled).rejects.toThrow("Aborted")
        let ran = false
        const next = FileTime.withLock(filePath, async () => {
          ran = true
        })
        try {
          await Bun.sleep(10)
          expect(ran).toBe(false)
        } finally {
          exit.resolve()
          await Promise.all([owner, next])
        }
        expect(ran).toBe(true)
      },
    })
  }))

test("a file changed during an edit approval is preserved", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const filePath = path.join(tmp.path, "approved.txt")
        await Bun.write(filePath, "original\n")
        const ctx = context("approval-reader")
        await (await ReadTool.init()).execute({ filePath }, ctx)
        ctx.ask = async () => {
          await Bun.write(filePath, "external\n")
        }
        await expect(
          (await EditTool.init()).execute({ filePath, oldString: "original", newString: "changed" }, ctx),
        ).rejects.toThrow()
        expect(await Bun.file(filePath).text()).toBe("external\n")
      },
    })
  }))
