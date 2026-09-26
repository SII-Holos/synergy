import { expect, test, spyOn } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceFileService } from "../../src/workspace-file/service"
import { FileEntry } from "../../src/file/entry"
import { WorkspaceFileStatus } from "../../src/workspace-file/status"
import { testRuntime } from "../support/runtime"

test("the workspace service exposes conditional create, copy, move and delete", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        await WorkspaceFileService.createDirectory({ path: "folder", createParents: false })
        await Bun.write(path.join(tmp.path, "folder", "file.txt"), "original")
        const original = await WorkspaceFileService.node("folder")
        const copied = await WorkspaceFileService.copy({
          from: "folder",
          to: "copy",
          expectedVersion: original.entryVersion!,
        })
        const moved = await WorkspaceFileService.move({
          from: "copy",
          to: "renamed",
          expectedVersion: copied.node.entryVersion!,
        })
        expect(await Bun.file(path.join(tmp.path, "renamed", "file.txt")).text()).toBe("original")
        await WorkspaceFileService.remove({
          path: "renamed",
          recursive: true,
          expectedVersion: moved.node.entryVersion!,
        })
        expect(await fs.readdir(tmp.path)).not.toContain("renamed")
        expect(await Bun.file(path.join(tmp.path, "folder", "file.txt")).text()).toBe("original")
        const fresh = await WorkspaceFileService.node("folder/file.txt")
        await Bun.write(path.join(tmp.path, "folder", "file.txt"), "new")
        await expect(
          WorkspaceFileService.remove({ path: fresh.path, expectedVersion: fresh.entryVersion!, recursive: false }),
        ).rejects.toThrow("changed")
      },
    })
  })
})

test("workspace entry operations protect roots, secret descendants and escaped parents", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        await fs.mkdir(path.join(tmp.path, "folder"))
        await Bun.write(path.join(tmp.path, "folder", ".env"), "private")
        const folder = await WorkspaceFileService.node("folder")
        await expect(
          WorkspaceFileService.remove({ path: "folder", expectedVersion: folder.entryVersion!, recursive: true }),
        ).rejects.toThrow("Access denied")
        await expect(
          WorkspaceFileService.copy({ from: "folder", to: "copy", expectedVersion: folder.entryVersion! }),
        ).rejects.toThrow("Access denied")
        await expect(
          WorkspaceFileService.move({
            from: "",
            to: "moved-root",
            expectedVersion: (await WorkspaceFileService.node("")).entryVersion!,
          }),
        ).rejects.toThrow("Access denied")
        await fs.symlink(outside.path, path.join(tmp.path, "outside"))
        await expect(
          WorkspaceFileService.createDirectory({ path: "outside/new", createParents: false }),
        ).rejects.toThrow("Access denied")
        const link = await WorkspaceFileService.node("outside")
        expect(link.symlink).toBe(true)
        await WorkspaceFileService.remove({ path: "outside", expectedVersion: link.entryVersion!, recursive: false })
        expect((await fs.stat(outside.path)).isDirectory()).toBe(true)
      },
    })
  })
})

test("node metadata and entry version come from the same filesystem observation", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const target = path.join(tmp.path, "file.txt")
        await Bun.write(target, "old")
        const before = await FileEntry.inspect(target)
        const status = spyOn(WorkspaceFileStatus, "statusForPath").mockImplementation(async () => {
          await Bun.write(target, "new content")
          return undefined
        })
        try {
          const node = await WorkspaceFileService.node("file.txt")
          expect(node.size).toBe(3)
          expect(node.entryVersion).toBe(before!.version)
          expect(node.entryVersion).not.toBe((await FileEntry.inspect(target))!.version)
        } finally {
          status.mockRestore()
        }
      },
    })
  })
})
