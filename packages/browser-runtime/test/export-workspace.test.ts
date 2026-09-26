import { afterAll, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { FileWatcher } from "@ericsanchezok/synergy-local-runtime/file/watcher"
import { WorkspaceEvents } from "@ericsanchezok/synergy-harness/workspace/events"
import { BrowserDownloads } from "../src/downloads"
import { BrowserExport } from "../src/export"
import { testRuntime } from "./support/runtime"

const runtime = await testRuntime(registerLocalRuntime)
afterAll(() => runtime.close())

async function download() {
  const owner = {
    mode: "session" as const,
    scopeID: ScopeContext.current.scope.id,
    sessionID: "export-test",
    directory: ScopeContext.current.directory,
  }
  const source = await BrowserDownloads.managedPath(owner, "download-test", "source.bin")
  await Bun.write(source, new Uint8Array([0, 1, 255, 4]))
  BrowserDownloads.add(owner, {
    id: "download-test",
    pageID: "page",
    url: "https://example.test/file",
    suggestedFilename: "source.bin",
    state: "completed",
    path: source,
    createdAt: Date.now(),
  })
  return { owner, source }
}

test(
  "cancelling an export queued behind a writer creates no files or parent directories",
  () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await ScopeContext.provide({
        scope: await tmp.scope(),
        async fn() {
          const { owner } = await download()
          const started = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>()
          const blocked = WorkspaceAccess.write([tmp.path], async () => {
            started.resolve()
            await release.promise
          })
          await started.promise
          const controller = new AbortController()
          const target = await BrowserExport.fileTarget(tmp.path, "new/download.bin")
          let settled = false
          const exporting = BrowserDownloads.exportTo(owner, "download-test", target, controller.signal)
          void exporting
            .finally(() => {
              settled = true
            })
            .catch(() => {})
          try {
            await Bun.sleep(100)
            expect(settled).toBe(false)
            controller.abort()
            await expect(exporting).rejects.toMatchObject({ name: "AbortError" })
            expect(await Bun.file(target).exists()).toBe(false)
            expect(await fs.readdir(tmp.path)).not.toContain("new")
          } finally {
            controller.abort()
            release.resolve()
            await blocked
            await exporting.catch(() => {})
          }
        },
      })
    }),
  10000,
)

test("an export cannot reuse a retired Workspace generation", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await using replacement = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const { owner } = await download()
        const selected = ScopeContext.current.workspace!
        const record = await WorkspaceCatalog.get(selected.id!, selected.scopeID)
        await WorkspaceBinding.rebind(record.id, {
          scopeID: record.scopeID,
          expectedRevision: record.revision,
          path: replacement.path,
        })
        await expect(
          BrowserDownloads.exportTo(owner, "download-test", path.join(tmp.path, "stale.bin")),
        ).rejects.toThrow()
        expect(await Bun.file(path.join(tmp.path, "stale.bin")).exists()).toBe(false)
        expect(await Bun.file(path.join(replacement.path, "stale.bin")).exists()).toBe(false)
      },
    })
  }))

test("a binary download preserves exact bytes and publishes its captured Workspace identity", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const { owner, source } = await download()
        const events: Array<{ file: string; workspaceID: string; workspaceGeneration: number }> = []
        const unsubscribe = WorkspaceEvents.subscribe(FileWatcher.Event.Updated, ({ properties }) =>
          events.push(properties),
        )
        try {
          const target = await BrowserDownloads.exportTo(owner, "download-test", "nested/private/file.bin")
          expect(new Uint8Array(await Bun.file(target).arrayBuffer())).toEqual(new Uint8Array([0, 1, 255, 4]))
          expect(new Uint8Array(await Bun.file(source).arrayBuffer())).toEqual(new Uint8Array([0, 1, 255, 4]))
          expect(events).toContainEqual(
            expect.objectContaining({
              file: "nested/private/file.bin",
              workspaceID: ScopeContext.current.workspace!.id,
              workspaceGeneration: ScopeContext.current.workspace!.generation,
            }),
          )
          if (process.platform !== "win32") expect((await fs.stat(path.dirname(target))).mode & 0o777).toBe(0o700)
          await expect(BrowserDownloads.exportTo(owner, "download-test", target)).rejects.toThrow("changed")
          expect(new Uint8Array(await Bun.file(target).arrayBuffer())).toEqual(new Uint8Array([0, 1, 255, 4]))
        } finally {
          unsubscribe()
        }
      },
    })
  }))

test("bundle publication is complete and a failed or duplicate export preserves existing files", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const workspace = BrowserExport.capture()
        const populate = async (directory: string) => {
          await Bun.write(path.join(directory, "nested", "asset.css"), "body {}")
          await Bun.write(path.join(directory, "report.json"), '{"complete":true}')
        }
        const destination = await BrowserExport.bundle(workspace, "assets", populate)
        expect(await Bun.file(path.join(destination, "nested", "asset.css")).text()).toBe("body {}")
        expect((await fs.readdir(destination)).sort()).toEqual(["nested", "report.json"])
        await expect(BrowserExport.bundle(workspace, "assets", populate)).rejects.toThrow("changed")
        await expect(
          BrowserExport.bundle(workspace, "assets", async (directory) => {
            await Bun.write(path.join(directory, "partial"), "not published")
            throw new Error("download failed")
          }),
        ).rejects.toThrow("download failed")
        expect(await Bun.file(path.join(destination, "report.json")).text()).toBe('{"complete":true}')
        expect(await Bun.file(path.join(destination, "partial")).exists()).toBe(false)
      },
    })
  }))

test("exports refuse protected destinations and symbolic-link parents before creating directories", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const workspace = BrowserExport.capture()
        await fs.symlink(outside.path, path.join(tmp.path, "escape"), "junction")
        for (const target of ["new/.env", ".git/private/file", "escape/new/report.json"])
          await expect(BrowserExport.writeFile(workspace, target, "data")).rejects.toThrow()
        expect(await fs.readdir(tmp.path)).not.toContain("new")
        expect(await fs.readdir(tmp.path)).not.toContain(".git")
        expect(await fs.readdir(outside.path)).not.toContain("new")
        await BrowserExport.writeFile(workspace, "report.json", '{"ok":true}')
        expect(await Bun.file(path.join(tmp.path, "report.json")).text()).toBe('{"ok":true}')
      },
    })
  }))

test("a source changed while waiting for a writer is not silently exported", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await using sources = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const source = path.join(sources.path, "source")
        await Bun.write(source, "original")
        const started = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const captured = Promise.withResolvers<void>()
        const blocked = WorkspaceAccess.write([tmp.path], async () => {
          started.resolve()
          await release.promise
        })
        await started.promise
        const exporting = BrowserExport.copy(BrowserExport.capture(), "copy", source, undefined, async () => {
          captured.resolve()
        })
        try {
          await captured.promise
          await Bun.write(source, "changed while queued")
          release.resolve()
          await expect(exporting).rejects.toThrow("changed")
          expect(await Bun.file(path.join(tmp.path, "copy")).exists()).toBe(false)
          expect(await Bun.file(source).text()).toBe("changed while queued")
        } finally {
          release.resolve()
          await blocked
          await exporting.catch(() => {})
        }
      },
    })
  }))

test("bundle collection cannot retarget publication after its Workspace is rebound", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await using replacement = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const selected = BrowserExport.capture()
        await expect(
          BrowserExport.bundle(selected, "assets", async (directory) => {
            await Bun.write(path.join(directory, "asset"), "old binding")
            const record = await WorkspaceCatalog.get(selected.id!, selected.scopeID)
            await WorkspaceBinding.rebind(record.id, {
              scopeID: record.scopeID,
              expectedRevision: record.revision,
              path: replacement.path,
            })
          }),
        ).rejects.toThrow()
        expect(await fs.readdir(tmp.path)).not.toContain("assets")
        expect(await fs.readdir(replacement.path)).not.toContain("assets")
      },
    })
  }))

test("a download owner cannot export into another Scope", () =>
  runtime.run(async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()
    const { owner } = await ScopeContext.provide({ scope: await first.scope(), fn: download })
    await ScopeContext.provide({
      scope: await second.scope(),
      async fn() {
        await expect(BrowserDownloads.exportTo(owner, "download-test", "copy")).rejects.toThrow("another Scope")
        expect(await Bun.file(path.join(second.path, "copy")).exists()).toBe(false)
      },
    })
  }))
