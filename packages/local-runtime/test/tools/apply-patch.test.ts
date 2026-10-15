import { expect, test, spyOn } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { FileTime } from "@ericsanchezok/synergy-harness/file/time"
import { WorkspaceEvents } from "@ericsanchezok/synergy-harness/workspace/events"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { ApplyPatchTool } from "../../src/tools/apply-patch"
import { FileEntry } from "../../src/file/entry"
import { FileMutation } from "../../src/file/mutation"
import { File } from "../../src/file"
import { testRuntime } from "../support/runtime"

const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`
const context = (): Tool.Context => ({
  sessionID: "patch-fixture",
  messageID: "msg_patch",
  callID: "patch",
  agent: "fixture",
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
})

async function fixture(
  fn: (dir: string, tool: Awaited<ReturnType<typeof ApplyPatchTool.init>>, ctx: Tool.Context) => Promise<void>,
) {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.txt"), "one\r\ntwo")
        await Bun.write(path.join(dir, "b.txt"), "delete me\n")
      },
    })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const ctx = context()
        for (const name of ["a.txt", "b.txt"])
          FileTime.read(ctx.sessionID, path.join(tmp.path, name), await Bun.file(path.join(tmp.path, name)).bytes())
        await fn(tmp.path, await ApplyPatchTool.init(), ctx)
      },
    })
  })
}

test("preflights a whole patch and applies add, update/move and delete in order", () =>
  fixture(async (dir, tool, ctx) => {
    const result = await tool.execute(
      {
        patch: patch(
          "*** Add File: nested/new.txt\n+hello\n*** Update File: a.txt\n*** Move to: moved.txt\n@@\n-one\n+ONE\n two\n*** Delete File: b.txt",
        ),
      },
      ctx,
    )
    expect(result.metadata.outcome).toBe("applied")
    expect(await Bun.file(path.join(dir, "moved.txt")).text()).toBe("ONE\r\ntwo")
    expect(await Bun.file(path.join(dir, "nested/new.txt")).text()).toBe("hello\n")
    expect(await Bun.file(path.join(dir, "a.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(dir, "b.txt")).exists()).toBe(false)
    expect(result.metadata.sections.every((row) => row.state === "committed")).toBe(true)
  }))

for (const body of [
  "*** Add File: added.txt\n+x\n*** Update File: a.txt\n@@\n-missing\n+new",
  "*** Add File: added.txt\n+x\n*** Delete File: missing.txt",
  "*** Update File: a.txt\n*** Move to: b.txt",
  "*** Update File: a.txt\n*** Move to: x.txt\n*** Add File: a.txt\n+alias",
  "*** Delete File: a.txt\n*** Delete File: ./a.txt",
])
  test(`invalid plan has zero effects: ${body.split("\n").at(-1)}`, () =>
    fixture(async (dir, tool, ctx) => {
      await expect(tool.execute({ patch: patch(body) }, ctx)).rejects.toThrow()
      expect(await Bun.file(path.join(dir, "a.txt")).text()).toBe("one\r\ntwo")
      expect(await Bun.file(path.join(dir, "b.txt")).text()).toBe("delete me\n")
      expect(await Bun.file(path.join(dir, "added.txt")).exists()).toBe(false)
    }))

test("permission refusal, stale reads, invalid UTF-8 and symlinks have zero effects", () =>
  fixture(async (dir, tool, ctx) => {
    const input = { patch: patch("*** Update File: a.txt\n@@\n-one\n+ONE") }
    await expect(
      tool.execute(input, {
        ...ctx,
        async ask() {
          throw new Error("refused")
        },
      }),
    ).rejects.toThrow("refused")
    await expect(tool.execute(input, { ...ctx, sessionID: "unread" })).rejects.toThrow("read")
    await fs.symlink("a.txt", path.join(dir, "link"))
    await expect(tool.execute({ patch: patch("*** Delete File: link") }, ctx)).rejects.toThrow("regular")
    await Bun.write(path.join(dir, "bad.bin"), new Uint8Array([0xff, 0]))
    await expect(tool.execute({ patch: patch("*** Delete File: bad.bin") }, ctx)).rejects.toThrow()
    expect(await Bun.file(path.join(dir, "a.txt")).text()).toBe("one\r\ntwo")
  }))

test("authorization wait revalidates every target before the first effect", () =>
  fixture(async (dir, tool, ctx) => {
    const result = tool.execute(
      { patch: patch("*** Add File: added.txt\n+x\n*** Delete File: b.txt") },
      {
        ...ctx,
        async ask() {
          await Bun.write(path.join(dir, "b.txt"), "concurrent\n")
        },
      },
    )
    await expect(result).rejects.toThrow()
    expect(await Bun.file(path.join(dir, "added.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(dir, "b.txt")).text()).toBe("concurrent\n")
  }))

test("replaced parent identity during authorization rejects an absent Add", () =>
  fixture(async (dir, tool, ctx) => {
    await fs.mkdir(path.join(dir, "parent"))
    await expect(
      tool.execute(
        { patch: patch("*** Add File: parent/new.txt\n+x") },
        {
          ...ctx,
          async ask() {
            await fs.rename(path.join(dir, "parent"), path.join(dir, "old-parent"))
            await fs.mkdir(path.join(dir, "parent"))
          },
        },
      ),
    ).rejects.toThrow()
    expect(await Bun.file(path.join(dir, "parent/new.txt")).exists()).toBe(false)
  }))

test("cancellation after a committed section preserves partial metadata and raw result", () =>
  fixture(async (dir, tool, ctx) => {
    const abort = new AbortController()
    let captured: unknown
    const ledgers: unknown[] = []
    await expect(
      tool.execute(
        { patch: patch("*** Add File: added.txt\n+x\n*** Delete File: b.txt") },
        {
          ...ctx,
          abort: abort.signal,
          metadata(value) {
            ledgers.push(structuredClone(value.metadata))
            if (value.metadata?.sections?.[0]?.state === "committed") abort.abort()
          },
          async captureResult(value) {
            captured = value
          },
        },
      ),
    ).rejects.toThrow(/partial|committed/i)
    expect(await Bun.file(path.join(dir, "added.txt")).text()).toBe("x\n")
    expect(await Bun.file(path.join(dir, "b.txt")).exists()).toBe(true)
    expect(captured).toMatchObject({
      metadata: { outcome: "partial", sections: [{ state: "committed" }, { state: "not_started" }] },
    })
    expect(ledgers.length).toBeGreaterThan(1)
  }))

test("failed move reports the committed update at its original path", () =>
  fixture(async (dir, tool, ctx) => {
    let captured: unknown
    using failure = spyOn(FileEntry, "move").mockRejectedValue(new Error("move failed"))
    await expect(
      tool.execute(
        { patch: patch("*** Update File: a.txt\n*** Move to: moved.txt\n@@\n-one\n+ONE\n*** Delete File: b.txt") },
        {
          ...ctx,
          async captureResult(value) {
            captured = value
          },
        },
      ),
    ).rejects.toThrow(/write: committed, move: failed/)
    expect(await Bun.file(path.join(dir, "a.txt")).text()).toBe("ONE\r\ntwo")
    expect(await Bun.file(path.join(dir, "moved.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(dir, "b.txt")).exists()).toBe(true)
    expect(captured).toMatchObject({
      metadata: {
        outcome: "partial",
        sections: [
          {
            operations: [
              { phase: "write", state: "committed" },
              { phase: "move", state: "failed" },
            ],
          },
          { state: "not_started" },
        ],
      },
    })
  }))

test("a post-effect durability failure is unsaved and never retried", () =>
  fixture(async (dir, tool, ctx) => {
    const write = FileMutation.write
    let captured: unknown
    let attempts = 0
    using failure = spyOn(FileMutation, "write").mockImplementation(async (input) => {
      attempts++
      await write(input)
      throw new FileEntry.PartialError("durability failed", [input.path])
    })
    await expect(
      tool.execute(
        { patch: patch("*** Add File: added.txt\n+x\n*** Delete File: b.txt") },
        {
          ...ctx,
          async captureResult(value) {
            captured = value
          },
        },
      ),
    ).rejects.toThrow("unsaved: added.txt")
    expect(attempts).toBe(1)
    expect(await Bun.file(path.join(dir, "added.txt")).text()).toBe("x\n")
    expect(await Bun.file(path.join(dir, "b.txt")).exists()).toBe(true)
    expect(captured).toMatchObject({
      metadata: { outcome: "unresolved", sections: [{ state: "unsaved" }, { state: "not_started" }] },
    })
    expect(captured).toMatchObject({
      metadata: {
        files: [{ file: "added.txt", afterBytes: 2, additions: 1 }],
        sections: [{ afterVersion: FileTime.version("x\n") }, { state: "not_started" }],
      },
    })
  }))

test("move precondition failure after formatting records the failed move separately", () =>
  fixture(async (dir, tool, ctx) => {
    let captured: unknown
    const unsubscribe = WorkspaceEvents.subscribe(File.Event.Edited, async () => {
      await Bun.write(path.join(dir, "a.txt"), "FORMATTED\r\ntwo")
      await Bun.write(path.join(dir, "moved.txt"), "concurrent destination\n")
    })
    try {
      await expect(
        tool.execute(
          { patch: patch("*** Update File: a.txt\n*** Move to: moved.txt\n@@\n-one\n+ONE\n*** Delete File: b.txt") },
          {
            ...ctx,
            async captureResult(value) {
              captured = value
            },
          },
        ),
      ).rejects.toThrow(/write: committed, move: failed/)
      expect(captured).toMatchObject({
        metadata: {
          outcome: "partial",
          sections: [
            {
              phase: "move",
              state: "failed",
              observedPath: "a.txt",
              afterVersion: FileTime.version("FORMATTED\r\ntwo"),
              operations: [
                { phase: "write", state: "committed" },
                { phase: "move", state: "failed" },
              ],
            },
            { state: "not_started" },
          ],
        },
      })
      expect(await Bun.file(path.join(dir, "a.txt")).text()).toBe("FORMATTED\r\ntwo")
      expect(await Bun.file(path.join(dir, "moved.txt")).text()).toBe("concurrent destination\n")
      expect(await Bun.file(path.join(dir, "b.txt")).text()).toBe("delete me\n")
    } finally {
      unsubscribe()
    }
  }))

test("hard-linked source aliases are rejected before any target mutation", () =>
  fixture(async (dir, tool, ctx) => {
    await fs.link(path.join(dir, "a.txt"), path.join(dir, "alias.txt"))
    FileTime.read(ctx.sessionID, path.join(dir, "alias.txt"), "one\r\ntwo")
    await expect(
      tool.execute({ patch: patch("*** Delete File: a.txt\n*** Delete File: alias.txt") }, ctx),
    ).rejects.toThrow(/aliased/)
    expect(await Bun.file(path.join(dir, "a.txt")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, "alias.txt")).exists()).toBe(true)
  }))
