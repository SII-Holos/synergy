import { afterAll, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { BrowserBackendCommandSchema } from "@ericsanchezok/synergy-browser-core"
import { BrowserUploadTool } from "../../src/tools/browser-upload"
import { BrowserToolHelper } from "../../src/tools/browser-shared"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime(registerLocalRuntime)
afterAll(() => runtime.close())
const target = { kind: "css" as const, value: "input[type=file]" }
function context(signal = new AbortController().signal) {
  return {
    sessionID: "upload-session",
    messageID: "upload-message",
    callID: "upload-call",
    agent: "synergy",
    abort: signal,
    extra: {},
    metadata() {},
    async ask() {},
  }
}
function transport() {
  const page = spyOn(BrowserToolHelper, "resolvePage").mockResolvedValue({ id: "upload-page" } as never)
  const execute = spyOn(BrowserToolHelper, "execute").mockImplementation(async (_ctx, command) => {
    BrowserBackendCommandSchema.parse(command)
    return { type: "data", pageId: "upload-page", data: { uploaded: true } }
  })
  return {
    page,
    execute,
    [Symbol.dispose]() {
      page.mockRestore()
      execute.mockRestore()
    },
  }
}

test("cancelled browser upload reads no files and dispatches no browser command", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Bun.write(path.join(tmp.path, "data.bin"), new Uint8Array([0, 255, 1]))
        using host = transport()
        const controller = new AbortController()
        controller.abort()
        const tool = await BrowserUploadTool.init()
        await expect(tool.execute({ target, paths: ["data.bin"] }, context(controller.signal))).rejects.toMatchObject({
          name: "AbortError",
        })
        expect(host.execute).not.toHaveBeenCalled()
        expect(host.page).not.toHaveBeenCalled()
      },
    })
  }))

test("browser upload rejects an old Workspace generation before obtaining a browser page", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await using next = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Bun.write(path.join(tmp.path, "data.bin"), "old workspace")
        using host = transport()
        const workspace = ScopeContext.current.workspace!
        const record = await WorkspaceCatalog.get(workspace.id!, workspace.scopeID)
        await WorkspaceBinding.rebind(record.id, {
          scopeID: record.scopeID,
          expectedRevision: record.revision,
          path: next.path,
        })
        const tool = await BrowserUploadTool.init()
        await expect(tool.execute({ target, paths: ["data.bin"] }, context())).rejects.toThrow("binding")
        expect(host.execute).not.toHaveBeenCalled()
        expect(host.page).not.toHaveBeenCalled()
      },
    })
  }))

test("browser upload preserves binary bytes and refuses symlinks and oversized inputs", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const bytes = Buffer.from([0, 255, 13, 10, 7])
        const file = path.join(tmp.path, "data.bin")
        await Bun.write(file, bytes)
        using host = transport()
        const tool = await BrowserUploadTool.init()
        const result = await tool.execute({ target, paths: ["data.bin"] }, context())
        expect(result.metadata.totalBytes).toBe(bytes.length)
        expect(host.execute.mock.calls[0]?.[1]).toMatchObject({
          type: "upload",
          files: [{ name: "data.bin", dataBase64: bytes.toString("base64") }],
        })
        await fs.symlink(file, path.join(tmp.path, "link.bin"))
        await expect(tool.execute({ target, paths: ["link.bin"] }, context())).rejects.toThrow("symbolic link")
        const large = await fs.open(path.join(tmp.path, "large.bin"), "w")
        try {
          await large.truncate(25 * 1024 * 1024 + 1)
        } finally {
          await large.close()
        }
        await expect(tool.execute({ target, paths: ["large.bin"] }, context())).rejects.toThrow("25 MB")
        expect(host.execute).toHaveBeenCalledTimes(1)
      },
    })
  }))

test(
  "an upload pins its Workspace until dispatch finishes and a queued rebind cannot retarget its files",
  () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await using next = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          await Bun.write(path.join(tmp.path, "data.bin"), "original")
          await Bun.write(path.join(next.path, "data.bin"), "replacement")
          using host = transport()
          const entered = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>()
          host.page.mockImplementation(async () => {
            entered.resolve()
            await release.promise
            return { id: "upload-page" } as never
          })
          const workspace = ScopeContext.current.workspace!
          const record = await WorkspaceCatalog.get(workspace.id!, workspace.scopeID)
          const tool = await BrowserUploadTool.init()
          const uploading = tool.execute({ target, paths: ["data.bin"] }, context())
          void uploading.catch(() => {})
          await entered.promise
          try {
            await expect(
              WorkspaceBinding.rebind(record.id, {
                scopeID: record.scopeID,
                expectedRevision: record.revision,
                path: next.path,
              }),
            ).rejects.toThrow("busy")
            release.resolve()
            await uploading
            expect(host.execute.mock.calls[0]?.[1]).toMatchObject({
              files: [{ dataBase64: Buffer.from("original").toString("base64") }],
            })
            await WorkspaceBinding.rebind(record.id, {
              scopeID: record.scopeID,
              expectedRevision: record.revision,
              path: next.path,
            })
          } finally {
            release.resolve()
            await uploading.catch(() => {})
          }
        },
      })
    }),
  10000,
)

test.each(["grow", "same-size"] as const)("an upload rejects a file that changes during reading: %s", (mode) =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const file = path.join(tmp.path, "data.bin")
        await Bun.write(file, Buffer.alloc(128 * 1024, 1))
        await fs.utimes(file, new Date(1700000000000), new Date(1700000000000))
        const before = await fs.stat(file)
        using host = transport()
        const open = fs.open
        const handles: Array<Awaited<ReturnType<typeof fs.open>>> = []
        const intercepted = spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args)
          if (args[0] !== file) return handle
          handles.push(handle)
          const read = handle.read
          let changed = false
          handle.read = (async (...values: unknown[]) => {
            const result = await Reflect.apply(read, handle, values)
            if (!changed) {
              changed = true
              const replacement = await open(file, "r+")
              try {
                if (mode === "grow") await replacement.truncate(25 * 1024 * 1024 + 1)
                else {
                  await replacement.write(Buffer.from([2]), 0, 1, 0)
                  await replacement.utimes(before.atime, before.mtime)
                }
              } finally {
                await replacement.close()
              }
            }
            return result
          }) as typeof handle.read
          return handle
        })
        try {
          const tool = await BrowserUploadTool.init()
          await expect(tool.execute({ target, paths: ["data.bin"] }, context())).rejects.toThrow(
            mode === "grow" ? "25 MB" : "changed",
          )
          expect(host.execute).not.toHaveBeenCalled()
          expect(handles).toHaveLength(1)
          await expect(handles[0]!.stat()).rejects.toThrow()
        } finally {
          intercepted.mockRestore()
        }
      },
    })
  }),
)

test(
  "an upload enforces the total byte limit across individually valid files",
  () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          using host = transport()
          const files = ["first.bin", "second.bin", "third.bin"]
          for (const name of files) {
            const handle = await fs.open(path.join(tmp.path, name), "w")
            try {
              await handle.truncate(20 * 1024 * 1024)
            } finally {
              await handle.close()
            }
          }
          const tool = await BrowserUploadTool.init()
          await expect(tool.execute({ target, paths: files }, context())).rejects.toThrow("50 MB")
          expect(host.execute).not.toHaveBeenCalled()
        },
      })
    }),
  10000,
)

test("empty files remain valid uploads through the shared browser protocol", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Bun.write(path.join(tmp.path, "empty.txt"), "")
        using host = transport()
        const tool = await BrowserUploadTool.init()
        const result = await tool.execute({ target, paths: ["empty.txt"] }, context())
        expect(result.metadata.totalBytes).toBe(0)
        expect(host.execute.mock.calls[0]?.[1]).toMatchObject({ files: [{ name: "empty.txt", dataBase64: "" }] })
      },
    })
  }))
