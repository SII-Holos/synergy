import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { FileTime } from "@ericsanchezok/synergy-harness/file/time"
import { FileMutation } from "../../src/file/mutation"
import { WorkspaceFileService } from "../../src/workspace-file/service"
import { testRuntime } from "../support/runtime"

test("native Workspace read, write, copy, move and delete retain bytes beyond MAX_PATH", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const directory = path.join("nested-".repeat(12), "directory-".repeat(12))
        const name = path.join(directory, "content.txt")
        expect(path.join(tmp.path, name).length).toBeGreaterThan(260)
        await fs.mkdir(path.join(tmp.path, directory), { recursive: true })
        const bytes = "\ufeffnative\r\n原始内容\r\n"
        await fs.writeFile(path.join(tmp.path, name), bytes)
        expect(await FileMutation.readText(path.join(tmp.path, name))).toBe(bytes)
        const read = await WorkspaceFileService.read({ path: name, mode: "document" })
        expect(read).toMatchObject({ kind: "text", content: bytes, contentVersion: FileTime.version(bytes) })
        await WorkspaceFileService.write({
          path: name,
          content: bytes + "changed\r\n",
          expectedVersion: FileTime.version(bytes),
          encoding: "utf-8",
          createParents: false,
          conflictPolicy: "fail",
        })
        const node = await WorkspaceFileService.node(name)
        const copied = await WorkspaceFileService.copy({
          from: name,
          to: path.join(directory, "copy.txt"),
          expectedVersion: node.entryVersion!,
        })
        const moved = await WorkspaceFileService.move({
          from: copied.path,
          to: path.join(directory, "moved.txt"),
          expectedVersion: copied.node.entryVersion!,
        })
        expect(await fs.readFile(path.join(tmp.path, moved.path), "utf8")).toBe(bytes + "changed\r\n")
        await WorkspaceFileService.remove({
          path: moved.path,
          expectedVersion: moved.node.entryVersion!,
          recursive: false,
        })
        expect(await fs.readdir(path.join(tmp.path, directory))).toEqual(["content.txt"])
        const image = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
        await fs.writeFile(path.join(tmp.path, directory, "image.png"), image)
        expect(
          await WorkspaceFileService.read({ path: path.join(directory, "image.png"), mode: "document" }),
        ).toMatchObject({
          kind: "image",
          content: Buffer.from(image).toString("base64"),
          contentVersion: FileTime.version(image),
        })
      },
    })
  })
}, 30000)
