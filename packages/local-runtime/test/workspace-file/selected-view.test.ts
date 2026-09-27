import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceFileService as Files } from "../../src/workspace-file/service"
import { FileView } from "../../src/file/view"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import fs from "node:fs/promises"
import path from "node:path"

test("file workbench edits and browses dormant and live views without a controller directory", async () => {
  await using runtime = await testRuntime({
    register() {
      WorkspaceBlobs.register("fixture", {
        put: (hash, bytes) => Storage.writeBinary(["fixture", hash], bytes),
        get: (hash) => Storage.readBinary(["fixture", hash]),
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        await using source = await tmpdir()
        const sourceDirectory = path.join(source.path, "source")
        await fs.mkdir(sourceDirectory)
        const large = Buffer.alloc(9 * 1024 * 1024, "x")
        await Bun.write(path.join(sourceDirectory, "large.bin"), large)
        await Bun.write(path.join(sourceDirectory, "note.txt"), "transferred")
        const workspace = await WorkspaceCatalog.create({
          scopeID: Scope.home().id,
          backend: { provider: "objects", spec: { blobStore: "fixture" } },
        })
        const environment = await Environment.bind({
          scopeID: workspace.scopeID,
          ownerID: "owner",
          provider: "native",
          spec: {},
        })
        for (const live of [false, true]) {
          await using resources = await EnvironmentResources.resolve({
            scopeID: workspace.scopeID,
            workspaceID: workspace.id,
            environmentID: environment.id,
            needs: live ? { execution: "exec" } : { workspace: true },
          })
          await WorkspaceState.provide(
            { id: workspace.id, scopeID: workspace.scopeID, generation: workspace.binding.generation },
            () =>
              EnvironmentResources.provide(resources, live ? "live" : "dormant", async () => {
                const directory = live ? "live" : "dormant"
                const validateSource = async (filename: string) => {
                  if (!filename.startsWith(sourceDirectory)) throw new Error("source escaped")
                }
                await Files.importEntry({ from: sourceDirectory, to: `${directory}-import/tree`, validateSource })
                expect(new TextDecoder().decode(await FileView.bytes(`${directory}-import/tree/note.txt`))).toBe(
                  "transferred",
                )
                expect(await FileView.bytes(`${directory}-import/tree/large.bin`)).toEqual(large)
                expect(
                  await FileView.bytes(
                    `${directory}-import/tree/large.bin`,
                    { offset: 1, length: 5 * 1024 * 1024 },
                    5 * 1024 * 1024,
                  ),
                ).toEqual(large.subarray(1, 5 * 1024 * 1024 + 1))
                await expect(
                  Files.importEntry({ from: sourceDirectory, to: `${directory}-import/tree`, validateSource }),
                ).rejects.toBeInstanceOf(Files.WriteConflictError)
                await Bun.write(path.join(sourceDirectory, ".env"), "secret")
                await expect(
                  Files.importEntry({ from: sourceDirectory, to: `${directory}-protected`, validateSource }),
                ).rejects.toThrow("protected")
                expect(await FileView.stat(`${directory}-protected`)).toBeUndefined()
                await fs.unlink(path.join(sourceDirectory, ".env"))
                await Files.createDirectory({ path: directory, createParents: true })
                const written = await Files.write({
                  path: `${directory}/file.txt`,
                  content: "hello\nselected view",
                  encoding: "utf-8",
                  createParents: false,
                  conflictPolicy: "fail",
                  expectedVersion: null,
                })
                const read = await Files.read({ path: written.path, mode: "document" })
                expect(read.kind).toBe("text")
                if (read.kind === "text") expect(read.content).toBe("hello\nselected view")
                expect((await Files.children({ path: directory })).children.map((item) => item.name)).toEqual([
                  "file.txt",
                ])
                const source = await Files.node(directory)
                await Files.copy({ from: directory, to: `${directory}-copy`, expectedVersion: source.entryVersion! })
                const copied = await Files.node(`${directory}-copy`)
                await Files.move({ from: copied.path, to: `${directory}-moved`, expectedVersion: copied.entryVersion! })
                const moved = await Files.node(`${directory}-moved`)
                await Files.remove({ path: moved.path, recursive: true, expectedVersion: moved.entryVersion! })
                await expect(
                  Files.write({
                    path: `${directory}/.env`,
                    content: "private",
                    encoding: "utf-8",
                    createParents: false,
                    conflictPolicy: "fail",
                    expectedVersion: null,
                  }),
                ).rejects.toThrow("not editable")
                const served = await Files.serveFile({ path: written.path })
                expect(await new Response(served.stream).text()).toBe("hello\nselected view")
                await FileView.write(`${directory}/.env`, new TextEncoder().encode("protected"), null)
                const protectedDirectory = await Files.node(directory)
                await expect(
                  Files.copy({
                    from: directory,
                    to: "protected-copy",
                    expectedVersion: protectedDirectory.entryVersion!,
                  }),
                ).rejects.toThrow("protected")
                expect(await FileView.stat("protected-copy")).toBeUndefined()
              }),
          )
          expect((await Environment.get(environment.id, workspace.scopeID)).state).toBe(live ? "ready" : "idle")
        }
        await Environment.deallocate(environment.id, { scopeID: workspace.scopeID })
      },
    }),
  )
}, 30_000)
