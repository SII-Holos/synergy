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
import { FileView } from "../../src/file/view"
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

test("Add replaces an observed regular file without bypassing read evidence", () =>
  fixture(async (dir, tool, ctx) => {
    const input = { patch: patch("*** Add File: a.txt\n+replacement") }
    await expect(tool.execute(input, { ...ctx, sessionID: "unread-add" })).rejects.toThrow("read")
    const result = await tool.execute(input, ctx)
    expect(await Bun.file(path.join(dir, "a.txt")).text()).toBe("replacement\n")
    expect(result.metadata.files).toMatchObject([{ file: "a.txt", beforeBytes: 8, afterBytes: 12 }])
  }))

test("Move writes an observed destination and removes the source with both real file diffs", () =>
  fixture(async (dir, tool, ctx) => {
    const input = { patch: patch("*** Update File: a.txt\n*** Move to: b.txt\n@@\n-one\n+ONE") }
    const result = await tool.execute(input, ctx)
    expect(await Bun.file(path.join(dir, "a.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(dir, "b.txt")).text()).toBe("ONE\r\ntwo")
    expect(result.metadata.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "a.txt", beforeBytes: 8, afterBytes: 0 }),
        expect.objectContaining({ file: "b.txt", beforeBytes: 10, afterBytes: 8 }),
      ]),
    )
    expect(result.metadata.sections[0]!.operations).toMatchObject([
      {
        phase: "write",
        path: "b.txt",
        state: "committed",
        beforeVersion: FileTime.version("delete me\n"),
        afterVersion: FileTime.version("ONE\r\ntwo"),
      },
      {
        phase: "delete",
        path: "a.txt",
        state: "committed",
        beforeVersion: FileTime.version("one\r\ntwo"),
        afterVersion: null,
      },
    ])
    expect(() => FileTime.assert(ctx.sessionID, path.join(dir, "a.txt"), "")).toThrow("read")
    FileTime.assert(ctx.sessionID, path.join(dir, "b.txt"), "ONE\r\ntwo")
  }))

test("Move creates missing parent directories through the selected writer", () =>
  fixture(async (dir, tool, ctx) => {
    const result = await tool.execute({ patch: patch("*** Update File: a.txt\n*** Move to: new/deep/file.txt") }, ctx)
    expect(result.metadata.outcome).toBe("applied")
    expect(await Bun.file(path.join(dir, "new/deep/file.txt")).text()).toBe("one\r\ntwo")
    expect(await Bun.file(path.join(dir, "a.txt")).exists()).toBe(false)
  }))

test("Move retains complete patches for both files beyond the bounded inline previews", () =>
  fixture(async (dir, tool, ctx) => {
    const source = Array.from({ length: 12 }, (_, index) => `source-${index}: ${"a".repeat(400)}`).join("\n") + "\n"
    const destination = source.replaceAll("source-", "destination-")
    const changed = source.replaceAll("a", "b")
    for (const [file, content] of [
      ["a.txt", source],
      ["b.txt", destination],
    ] as const) {
      await Bun.write(path.join(dir, file), content)
      FileTime.read(ctx.sessionID, path.join(dir, file), content)
    }
    const result = await tool.execute(
      {
        patch: patch(
          `*** Update File: a.txt\n*** Move to: b.txt\n@@\n${source
            .trimEnd()
            .split("\n")
            .map((line) => `-${line}`)
            .join("\n")}\n${changed
            .trimEnd()
            .split("\n")
            .map((line) => `+${line}`)
            .join("\n")}`,
        ),
      },
      ctx,
    )
    const files = result.metadata.sections[0]!.files
    expect(result.metadata.files).toEqual(files)
    expect(files.map((file) => file.file)).toEqual(["b.txt", "a.txt"])
    const destinationDiff = files[0]!
    expect(destinationDiff.preview).toContain("characters omitted")
    expect(destinationDiff.patch!.length).toBeGreaterThan(destinationDiff.preview!.length)
    expect(destinationDiff.patch).not.toContain("characters omitted")
    expect(destinationDiff.patch).toContain(`-destination-6: ${"a".repeat(400)}`)
    expect(destinationDiff.patch).toContain(`+source-6: ${"b".repeat(400)}`)
    expect(files[1]!.patch).toContain(`-source-6: ${"a".repeat(400)}`)
    expect(await Bun.file(path.join(dir, "b.txt")).text()).toBe(changed)
  }))

test("Move to a missing file preserves source permissions while overwrites retain destination permissions", () =>
  fixture(async (dir, tool, ctx) => {
    if (process.platform === "win32") return
    await fs.chmod(path.join(dir, "a.txt"), 0o751)
    await fs.chmod(path.join(dir, "b.txt"), 0o640)
    await tool.execute({ patch: patch("*** Update File: a.txt\n*** Move to: new/script.sh") }, ctx)
    expect((await fs.stat(path.join(dir, "new/script.sh"))).mode & 0o777).toBe(0o751)
    await tool.execute({ patch: patch("*** Update File: new/script.sh\n*** Move to: b.txt") }, ctx)
    expect((await fs.stat(path.join(dir, "b.txt"))).mode & 0o777).toBe(0o640)
  }))

test("overwritten destinations still require current read evidence and authorization-time identities", () =>
  fixture(async (dir, tool, ctx) => {
    await Bun.write(path.join(dir, "target.txt"), "target\n")
    const input = { patch: patch("*** Update File: a.txt\n*** Move to: target.txt") }
    await expect(tool.execute(input, ctx)).rejects.toThrow("read")
    FileTime.read(ctx.sessionID, path.join(dir, "target.txt"), "target\n")
    await expect(
      tool.execute(input, {
        ...ctx,
        async ask() {
          await Bun.write(path.join(dir, "target.txt"), "concurrent\n")
        },
      }),
    ).rejects.toThrow()
    expect(await Bun.file(path.join(dir, "a.txt")).text()).toBe("one\r\ntwo")
    expect(await Bun.file(path.join(dir, "target.txt")).text()).toBe("concurrent\n")
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

test("failed source removal retains the committed destination without replaying the move", () =>
  fixture(async (dir, tool, ctx) => {
    let captured: unknown
    using failure = spyOn(FileEntry, "remove").mockRejectedValue(new Error("remove failed"))
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
    ).rejects.toThrow(/write: committed, delete: failed/)
    expect(await Bun.file(path.join(dir, "a.txt")).text()).toBe("one\r\ntwo")
    expect(await Bun.file(path.join(dir, "moved.txt")).text()).toBe("ONE\r\ntwo")
    expect(await Bun.file(path.join(dir, "b.txt")).exists()).toBe(true)
    expect(captured).toMatchObject({
      metadata: {
        outcome: "partial",
        files: [{ file: "moved.txt", beforeBytes: 0, afterBytes: 8 }],
        sections: [
          {
            operations: [
              { phase: "write", path: "moved.txt", state: "committed" },
              { phase: "delete", path: "a.txt", state: "failed" },
            ],
          },
          { state: "not_started" },
        ],
      },
    })
  }))

test("cancelling a Move after destination commit preserves the source and only records the written target", () =>
  fixture(async (dir, tool, ctx) => {
    const abort = new AbortController()
    let captured: unknown
    await expect(
      tool.execute(
        { patch: patch("*** Update File: a.txt\n*** Move to: moved.txt\n@@\n-one\n+ONE") },
        {
          ...ctx,
          abort: abort.signal,
          metadata(value) {
            if (value.metadata?.sections?.[0]?.operations?.[0]?.state === "committed") abort.abort()
          },
          async captureResult(value) {
            captured = value
          },
        },
      ),
    ).rejects.toThrow(/partial/i)
    expect(await Bun.file(path.join(dir, "a.txt")).text()).toBe("one\r\ntwo")
    expect(await Bun.file(path.join(dir, "moved.txt")).text()).toBe("ONE\r\ntwo")
    expect(captured).toMatchObject({
      metadata: {
        outcome: "partial",
        files: [{ file: "moved.txt", beforeBytes: 0, afterBytes: 8 }],
        sections: [{ operations: [{ phase: "write", path: "moved.txt", state: "committed" }] }],
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

test("a changed source after destination formatting prevents removal and retains only the destination diff", () =>
  fixture(async (dir, tool, ctx) => {
    let captured: unknown
    const unsubscribe = WorkspaceEvents.subscribe(File.Event.Edited, async () => {
      await Bun.write(path.join(dir, "a.txt"), "concurrent source\n")
      await FileView.formatting(path.join(dir, "moved.txt"), async () => {
        await Bun.write(path.join(dir, "moved.txt"), "FORMATTED\r\ntwo")
        return { exitCode: 0 }
      })
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
      ).rejects.toThrow(/write: committed, delete: failed/)
      expect(captured).toMatchObject({
        metadata: {
          outcome: "partial",
          files: [{ file: "moved.txt", beforeBytes: 0, afterBytes: 14 }],
          sections: [
            {
              phase: "delete",
              state: "failed",
              observedPath: "moved.txt",
              afterVersion: FileTime.version("FORMATTED\r\ntwo"),
              operations: [
                { phase: "write", path: "moved.txt", state: "committed" },
                { phase: "delete", path: "a.txt", state: "failed" },
              ],
            },
            { state: "not_started" },
          ],
        },
      })
      expect(await Bun.file(path.join(dir, "a.txt")).text()).toBe("concurrent source\n")
      expect(await Bun.file(path.join(dir, "moved.txt")).text()).toBe("FORMATTED\r\ntwo")
      expect(await Bun.file(path.join(dir, "b.txt")).text()).toBe("delete me\n")
    } finally {
      unsubscribe()
    }
  }))

for (const replace of [false, true])
  test(`a ${replace ? "replaced" : "rewritten"} Move destination during file-edited callbacks cannot authorize source deletion`, () =>
    fixture(async (dir, tool, ctx) => {
      let captured: unknown
      const target = path.join(dir, "b.txt")
      const unsubscribe = WorkspaceEvents.subscribe(File.Event.Edited, async () => {
        if (replace) {
          const replacement = path.join(dir, "replacement.txt")
          await Bun.write(replacement, "unrelated concurrent replacement\n")
          await fs.rename(replacement, target)
        } else await Bun.write(target, "unrelated concurrent replacement\n")
      })
      try {
        await expect(
          tool.execute(
            { patch: patch("*** Update File: a.txt\n*** Move to: b.txt") },
            {
              ...ctx,
              async captureResult(result) {
                captured = result
              },
            },
          ),
        ).rejects.toThrow()
        expect(await Bun.file(path.join(dir, "a.txt")).text()).toBe("one\r\ntwo")
        expect(await Bun.file(target).text()).toBe("unrelated concurrent replacement\n")
        expect(captured).toMatchObject({
          metadata: {
            outcome: "partial",
            files: [{ file: "b.txt", beforeBytes: 10, afterBytes: 8 }],
            sections: [
              {
                operations: [
                  { phase: "write", path: "b.txt", state: "committed", afterVersion: FileTime.version("one\r\ntwo") },
                ],
              },
            ],
          },
        })
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
