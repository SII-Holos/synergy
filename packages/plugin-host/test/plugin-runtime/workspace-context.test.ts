import { afterAll, expect, spyOn, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { compilePluginManifest } from "@ericsanchezok/synergy-plugin"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceFileService } from "@ericsanchezok/synergy-local-runtime/workspace-file/service"
import { FileMutation } from "@ericsanchezok/synergy-local-runtime/file/mutation"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { pluginRuntimeManager } from "../../src/plugin/runtime"
import definition from "./fixtures/workspace-plugin"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const entryPath = path.join(import.meta.dir, "fixtures", "workspace-plugin.ts")
const manifest = compilePluginManifest(definition, {
  generation: "workspace-ownership",
  runtime: { entry: "runtime/index.js", sha256: "test" },
})

for (const mode of ["process", "inProcess"] as const) {
  test(`plugin ${mode} file writes preserve task ownership and write evidence`, () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const scope = await tmp.scope()
      await ScopeContext.provide({
        scope,
        async fn() {
          const manager = pluginRuntimeManager()
          const session = await Session.create()
          await manager.start({ manifest, entryPath, pluginDir: path.dirname(entryPath), mode, trustedBuiltin: true })
          let writes = 0
          try {
            await WorkspaceAccess.task({ sessionID: session.id, workspace: session.workspace }, () =>
              WorkspaceAccess.observeWrites(
                async () => {
                  writes++
                  return { async finish() {} }
                },
                async () => {
                  await FileMutation.write({ path: path.join(tmp.path, "file.txt"), content: "\ufeffbefore\r\n" })
                  const result = await manager.invoke({
                    pluginId: manifest.id,
                    handlerId: "operation:edit",
                    value: { path: "file.txt", content: "after\r\n" },
                    context: { scopeId: scope.id, sessionId: session.id, directory: tmp.path, actor: { type: "ui" } },
                    pluginDir: path.dirname(entryPath),
                    manifest,
                    timeoutMs: 2000,
                  })
                  expect(result).toEqual({ before: "\ufeffbefore\r\n", after: "after\r\n" })
                },
              ),
            )
            expect(writes).toBe(2)
            expect(await Bun.file(path.join(tmp.path, "file.txt")).text()).toBe("after\r\n")
          } finally {
            await manager.stop(manifest.id)
            await Session.remove(session.id)
          }
        },
      })
    }))
}

test("one plugin generation writes to two canonical Session Workspaces independently", () =>
  runtime.run(async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    await ScopeContext.provide({
      scope: await a.scope(),
      async fn() {
        const scope = ScopeContext.current.scope
        const first = await Session.create()
        const second = await Session.create()
        const binding = await WorkspaceBinding.register(scope.id, b.path)
        await Session.updateWorkspace(second.id, WorkspaceCatalog.projection(binding))
        const manager = pluginRuntimeManager()
        await manager.start({ manifest, entryPath, pluginDir: path.dirname(entryPath) })
        const invoke = (sessionId: string, content: string) =>
          manager.invoke({
            pluginId: manifest.id,
            handlerId: "operation:write",
            value: { path: "nested/new.txt", content },
            context: { scopeId: scope.id, sessionId, directory: a.path, actor: { type: "ui" as const } },
            pluginDir: path.dirname(entryPath),
            manifest,
          })
        try {
          await Promise.all([invoke(first.id, "first"), invoke(second.id, "second")])
          expect(await Bun.file(path.join(a.path, "nested/new.txt")).text()).toBe("first")
          expect(await Bun.file(path.join(b.path, "nested/new.txt")).text()).toBe("second")
        } finally {
          await manager.stop(manifest.id)
          await Session.remove(first.id)
          await Session.remove(second.id)
        }
      },
    })
  }))

for (const boundary of ["external-edit", "session-switch", "rebind"] as const) {
  test(`plugin read/write retains its source through ${boundary}`, () =>
    runtime.run(async () => {
      await using tmp = await tmpdir(),
        next = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        async fn() {
          const session = await Session.create()
          const original = await WorkspaceCatalog.get(session.workspaceID!, session.scope.id)
          const manager = pluginRuntimeManager()
          await manager.start({ manifest, entryPath, pluginDir: path.dirname(entryPath) })
          await Bun.write(path.join(tmp.path, "file.txt"), "before")
          const entered = Promise.withResolvers<void>(),
            proceed = Promise.withResolvers<void>()
          const write = WorkspaceFileService.write
          const paused = spyOn(WorkspaceFileService, "write").mockImplementation(async (...args) => {
            entered.resolve()
            await proceed.promise
            return write(...args)
          })
          let rebound: Promise<unknown> | undefined
          try {
            const pending = manager
              .invoke({
                pluginId: manifest.id,
                handlerId: "operation:edit",
                value: { path: "file.txt", content: "after" },
                context: {
                  scopeId: session.scope.id,
                  sessionId: session.id,
                  directory: tmp.path,
                  actor: { type: "ui" },
                },
                pluginDir: path.dirname(entryPath),
                manifest,
                timeoutMs: 3000,
              })
              .then(
                (value) => ({ value }),
                (error: unknown) => ({ error }),
              )
            await entered.promise
            if (boundary === "external-edit") await Bun.write(path.join(tmp.path, "file.txt"), "outside")
            if (boundary === "session-switch") {
              const target = await WorkspaceBinding.register(session.scope.id, next.path)
              await Session.updateWorkspace(session.id, WorkspaceCatalog.projection(target))
            }
            if (boundary === "rebind") {
              const abort = new AbortController()
              const timer = setTimeout(() => abort.abort(new DOMException("Rebind cancelled", "AbortError")), 100)
              const blocked = await WorkspaceBinding.rebind(
                original.id,
                {
                  scopeID: session.scope.id,
                  expectedRevision: original.revision,
                  path: next.path,
                },
                abort.signal,
              ).then(
                () => undefined,
                (error: unknown) => error,
              )
              clearTimeout(timer)
              expect(blocked).toMatchObject({ name: "AbortError" })
            }
            proceed.resolve()
            const result = await pending
            if (boundary === "external-edit") {
              expect(result).toMatchObject({ error: { message: expect.stringContaining("changed on disk") } })
              expect(await Bun.file(path.join(tmp.path, "file.txt")).text()).toBe("outside")
            } else {
              expect(result).toEqual({ value: { before: "before", after: "after" } })
              expect(await Bun.file(path.join(tmp.path, "file.txt")).text()).toBe("after")
              expect(await Bun.file(path.join(next.path, "file.txt")).exists()).toBe(false)
            }
            if (boundary === "rebind") {
              rebound = WorkspaceBinding.rebind(original.id, {
                scopeID: session.scope.id,
                expectedRevision: original.revision,
                path: next.path,
              })
              expect(((await rebound) as { binding: { generation: number } }).binding.generation).toBe(
                original.binding.generation + 1,
              )
            }
          } finally {
            proceed.resolve()
            paused.mockRestore()
            await manager.stop(manifest.id)
            await rebound
            await Session.remove(session.id)
          }
        },
      })
    }))
}

test("cancelling a plugin queued behind another writer drains the Host request before releasing its invocation", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const session = await Session.create()
        const manager = pluginRuntimeManager()
        await manager.start({ manifest, entryPath, pluginDir: path.dirname(entryPath) })
        const entered = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>()
        const busy = WorkspaceAccess.write([tmp.path], async () => {
          entered.resolve()
          await release.promise
        })
        await entered.promise
        const controller = new AbortController()
        const requested = Promise.withResolvers<void>()
        const write = WorkspaceFileService.write
        const probe = spyOn(WorkspaceFileService, "write").mockImplementation((...args) => {
          requested.resolve()
          return write(...args)
        })
        try {
          const pending = manager
            .invoke({
              pluginId: manifest.id,
              handlerId: "operation:write",
              value: { path: "file.txt", content: "cancelled" },
              context: { scopeId: session.scope.id, sessionId: session.id, actor: { type: "ui" } },
              pluginDir: path.dirname(entryPath),
              manifest,
              signal: controller.signal,
            })
            .then(
              () => undefined,
              (error: unknown) => error,
            )
          await requested.promise
          controller.abort()
          expect(await pending).toMatchObject({ code: "CANCELLED" })
          expect(await Bun.file(path.join(tmp.path, "file.txt")).exists()).toBe(false)
          expect(manager.registry.active(manifest.id)?.inFlight).toBe(0)
        } finally {
          release.resolve()
          await busy
          probe.mockRestore()
          await manager.stop(manifest.id)
          await Session.remove(session.id)
        }
      },
    })
  }))

for (const mode of ["process", "inProcess"] as const) {
  test(`plugin ${mode} cannot report success while a Host write remains unjoined`, () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        async fn() {
          const session = await Session.create()
          const manager = pluginRuntimeManager()
          await manager.start({ manifest, entryPath, pluginDir: path.dirname(entryPath), mode, trustedBuiltin: true })
          const busy = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>()
          const writer = WorkspaceAccess.write([tmp.path], async () => {
            busy.resolve()
            await release.promise
          })
          await busy.promise
          try {
            const result = await manager
              .invoke({
                pluginId: manifest.id,
                handlerId: "operation:unjoined",
                value: { path: "late.txt", content: "late" },
                context: { scopeId: session.scope.id, sessionId: session.id, actor: { type: "ui" } },
                pluginDir: path.dirname(entryPath),
                manifest,
                timeoutMs: 2000,
              })
              .then(
                () => undefined,
                (error: unknown) => error,
              )
            expect(result).toMatchObject({ message: expect.stringContaining("before its Host Services settled") })
            expect(await Bun.file(path.join(tmp.path, "late.txt")).exists()).toBe(false)
            expect(manager.registry.active(manifest.id)?.inFlight).toBe(0)
          } finally {
            release.resolve()
            await writer
            await manager.stop(manifest.id)
            await Session.remove(session.id)
          }
        },
      })
    }))
}

test("plugin file services reject absent Workspaces, protected files and physical path escapes", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir(),
      outside = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const session = await Session.create()
        const manager = pluginRuntimeManager()
        await manager.start({ manifest, entryPath, pluginDir: path.dirname(entryPath) })
        const invoke = (filename: string) =>
          manager
            .invoke({
              pluginId: manifest.id,
              handlerId: "operation:write",
              value: { path: filename, content: "unsafe" },
              context: {
                scopeId: session.scope.id,
                sessionId: session.id,
                directory: tmp.path,
                actor: { type: "ui" as const },
              },
              pluginDir: path.dirname(entryPath),
              manifest,
            })
            .then(
              () => undefined,
              (error: unknown) => error,
            )
        try {
          await fs.symlink(
            outside.path,
            path.join(tmp.path, "external"),
            process.platform === "win32" ? "junction" : "dir",
          )
          expect(await invoke("external/file.txt")).toMatchObject({ message: expect.stringContaining("escapes") })
          expect(await Bun.file(path.join(outside.path, "file.txt")).exists()).toBe(false)
          expect(await invoke(".git/config")).toMatchObject({ message: expect.stringContaining("Git metadata") })
          await Session.updateWorkspace(session.id, null)
          expect(await invoke("file.txt")).toMatchObject({ message: expect.stringContaining("workspace is required") })
          expect(await Bun.file(path.join(tmp.path, "file.txt")).exists()).toBe(false)
        } finally {
          await manager.stop(manifest.id)
          await Session.remove(session.id)
        }
      },
    })
  }))
