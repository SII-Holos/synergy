import { afterAll, expect, test, spyOn } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { Snapshot } from "@ericsanchezok/synergy-harness/session/snapshot"
import { WorkspaceCatalog, WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { FileEntry } from "../../src/file/entry"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("native history restoration replaces a symlink entry without following its external target", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await using external = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const file = path.join(directory.path, "note.txt")
        const other = path.join(external.path, "private.txt")
        await Bun.write(file, "original\r\n")
        await Bun.write(other, "untouched")
        const from = (await Snapshot.track("restore-link"))!
        const source = Snapshot.workspace()!
        await fs.unlink(file)
        await fs.symlink(other, file)
        const result = await Snapshot.revert([{ hash: from, workspace: source, files: [file] }], "restore-link")
        expect(result).toEqual({ restoredFiles: [file], failedFiles: [] })
        expect((await fs.lstat(file)).isSymbolicLink()).toBe(false)
        expect(await Bun.file(file).text()).toBe("original\r\n")
        expect(await Bun.file(other).text()).toBe("untouched")
      },
    })
  }))

test("historical restoration cannot silently use a new binding generation", () =>
  runtime.run(async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()
    await ScopeContext.provide({
      scope: await first.scope(),
      fn: async () => {
        const file = path.join(first.path, "note.txt")
        await Bun.write(file, "original")
        const from = (await Snapshot.track("restore-rebind"))!
        const source = Snapshot.workspace()!
        await Bun.write(file, "changed")
        await Bun.write(path.join(second.path, "note.txt"), "other")
        const record = await WorkspaceCatalog.get(source.id, ScopeContext.current.scope.id)
        await WorkspaceBinding.rebind(source.id, {
          scopeID: record.scopeID,
          expectedRevision: record.revision,
          path: second.path,
        })
        await expect(
          Snapshot.revert([{ hash: from, workspace: source, files: [file] }], "restore-rebind"),
        ).rejects.toThrow()
        expect(await Bun.file(file).text()).toBe("changed")
        expect(await Bun.file(path.join(second.path, "note.txt")).text()).toBe("other")
      },
    })
  }))

test("unattributed patches cannot authorize deletion of an arbitrary absolute path", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await using external = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const from = (await Snapshot.track("restore-legacy"))!
        const other = path.join(external.path, "keep.txt")
        await Bun.write(other, "keep")
        await expect(Snapshot.revert([{ hash: from, files: [other] }], "restore-legacy")).rejects.toThrow()
        expect(await Bun.file(other).text()).toBe("keep")
      },
    })
  }))

test("entry replacement rejects stale identity and preserves existing directories", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const file = path.join(directory.path, "note.txt")
        await Bun.write(file, "observed")
        const before = (await FileEntry.inspect(file))!
        await Bun.write(file, "changed")
        await expect(
          FileEntry.replace({
            path: file,
            expectedVersion: before.version,
            content: Buffer.from("restored"),
            mode: "100644",
          }),
        ).rejects.toThrow("changed")
        expect(await Bun.file(file).text()).toBe("changed")
        const folder = path.join(directory.path, "folder")
        await fs.mkdir(folder)
        await Bun.write(path.join(folder, "keep"), "keep")
        await expect(
          FileEntry.replace({
            path: folder,
            expectedVersion: (await FileEntry.inspect(folder))!.version,
            content: Buffer.from("restored"),
            mode: "100644",
          }),
        ).rejects.toThrow()
        expect(await Bun.file(path.join(folder, "keep")).text()).toBe("keep")
      },
    })
  }))

test("a restore queued behind another writer detects its newer bytes", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const file = path.join(directory.path, "note.txt")
        await Bun.write(file, "original")
        const hash = (await Snapshot.track("restore-queued"))!
        const patch = { hash, workspace: Snapshot.workspace()!, files: [file] }
        await Bun.write(file, "selected")
        const coordinator = new WorkspaceCoordinator()
        const writer = await coordinator.acquire({
          id: crypto.randomUUID(),
          owner: "another-writer",
          ancestors: [],
          kind: "task",
          roots: [directory.path],
        })
        const controller = new AbortController()
        const restoring = Snapshot.revert([patch], "restore-queued", controller.signal)
        try {
          let queued = false
          for (let i = 0; i < 100; i++) {
            queued = (await coordinator.inspect()).some(
              (claim) =>
                claim.id !== writer.id &&
                claim.kind === "task" &&
                claim.state === "waiting" &&
                claim.roots?.some((root) => root.path === directory.path),
            )
            if (queued) break
            await Bun.sleep(10)
          }
          expect(queued).toBe(true)
          await Bun.write(file, "newer writer bytes")
          await writer.release()
          const result = await restoring
          expect(result.restoredFiles).toEqual([])
          expect(result.failedFiles).toMatchObject([{ file, code: "conflict" }])
          expect(await Bun.file(file).text()).toBe("newer writer bytes")
        } finally {
          controller.abort()
          await writer.release()
          await restoring.catch(() => {})
        }
      },
    })
  }))

test("partial restore reports only completed files and preserves a changed later file", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const first = path.join(directory.path, "a.txt"),
          second = path.join(directory.path, "b.txt")
        await Bun.write(first, "original-a")
        await Bun.write(second, "original-b")
        const hash = (await Snapshot.track("restore-partial"))!
        await Bun.write(first, "edited-a")
        await Bun.write(second, "edited-b")
        const replace = FileEntry.replace
        using trigger = spyOn(FileEntry, "replace").mockImplementation(async (input) => {
          const result = await replace(input)
          if (input.path === first) await Bun.write(second, "external newer version")
          return result
        })
        const result = await Snapshot.revert(
          [{ hash, workspace: Snapshot.workspace()!, files: [first, second] }],
          "restore-partial",
        )
        expect(result.restoredFiles).toEqual([first])
        expect(result.failedFiles).toMatchObject([{ file: second, code: "conflict" }])
        expect(await Bun.file(first).text()).toBe("original-a")
        expect(await Bun.file(second).text()).toBe("external newer version")
      },
    })
  }))

test("cancellation releases queued restore ownership without changing files", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const file = path.join(directory.path, "note.txt")
        await Bun.write(file, "original")
        const hash = (await Snapshot.track("restore-cancelled"))!
        await Bun.write(file, "keep")
        const coordinator = new WorkspaceCoordinator()
        const writer = await coordinator.acquire({
          id: crypto.randomUUID(),
          owner: "blocker",
          ancestors: [],
          kind: "task",
          roots: [directory.path],
        })
        try {
          await expect(
            Snapshot.revert(
              [{ hash, workspace: Snapshot.workspace()!, files: [file] }],
              "restore-cancelled",
              AbortSignal.timeout(150),
            ),
          ).rejects.toThrow()
          expect(await Bun.file(file).text()).toBe("keep")
          expect(
            (await coordinator.inspect()).filter((claim) => claim.roots?.some((root) => root.path === directory.path)),
          ).toHaveLength(1)
        } finally {
          await writer.release()
        }
      },
    })
  }))

test("restore retains exact binary bytes and BOMs without modifying hard-link aliases", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const file = path.join(directory.path, "bytes.txt"),
          alias = path.join(directory.path, "alias.txt")
        const bytes = Uint8Array.from([239, 187, 191, 0, 255, 128, 13, 10])
        await Bun.write(file, bytes)
        const hash = (await Snapshot.track("restore-bytes"))!
        await Bun.write(file, "changed")
        await fs.link(file, alias)
        const result = await Snapshot.revert(
          [{ hash, workspace: Snapshot.workspace()!, files: [file] }],
          "restore-bytes",
        )
        expect(result.failedFiles).toEqual([])
        expect(await Bun.file(file).bytes()).toEqual(bytes)
        expect(await Bun.file(alias).text()).toBe("changed")
      },
    })
  }))

test("restoring history targets each original Workspace while the session has no selected directory", () =>
  runtime.run(async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()
    const scope = await first.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const a = path.join(first.path, "same.txt"),
          b = path.join(second.path, "same.txt")
        await Bun.write(a, "original-a")
        const hashA = (await Snapshot.track("restore-multiple"))!
        const sourceA = Snapshot.workspace()!
        const recordB = await WorkspaceBinding.register(scope.id, second.path)
        const patchB = await ScopeContext.provide({
          scope,
          workspace: WorkspaceCatalog.projection(recordB),
          fn: async () => {
            await Bun.write(b, "original-b")
            const hash = (await Snapshot.track("restore-multiple"))!
            const added = path.join(second.path, "added.txt")
            await Bun.write(added, "new file")
            return { hash, workspace: Snapshot.workspace()!, files: [b, added] }
          },
        })
        await Bun.write(a, "edited-a")
        await Bun.write(b, "edited-b")
        const result = await ScopeContext.provide({
          scope,
          workspace: null,
          fn: () => Snapshot.revert([{ hash: hashA, workspace: sourceA, files: [a] }, patchB], "restore-multiple"),
        })
        expect(result.failedFiles).toEqual([])
        expect(result.restoredFiles).toHaveLength(3)
        expect(await Bun.file(a).text()).toBe("original-a")
        expect(await Bun.file(b).text()).toBe("original-b")
        expect(await Bun.file(path.join(second.path, "added.txt")).exists()).toBe(false)
      },
    })
  }))

test("all historical bindings are checked before any file is changed", () =>
  runtime.run(async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()
    const scope = await first.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const a = path.join(first.path, "same.txt"),
          b = path.join(second.path, "same.txt")
        await Bun.write(a, "original-a")
        const patchA = {
          hash: (await Snapshot.track("restore-preflight"))!,
          workspace: Snapshot.workspace()!,
          files: [a],
        }
        const recordB = await WorkspaceBinding.register(scope.id, second.path)
        const patchB = await ScopeContext.provide({
          scope,
          workspace: WorkspaceCatalog.projection(recordB),
          fn: async () => {
            await Bun.write(b, "original-b")
            return { hash: (await Snapshot.track("restore-preflight"))!, workspace: Snapshot.workspace()!, files: [b] }
          },
        })
        await Bun.write(a, "keep-a")
        await fs.rm(second.path, { recursive: true })
        await expect(Snapshot.revert([patchA, patchB], "restore-preflight")).rejects.toThrow()
        expect(await Bun.file(a).text()).toBe("keep-a")
      },
    })
  }))

test("restoration refuses an external parent link before publishing any files", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await using external = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const first = path.join(directory.path, "first.txt"),
          nested = path.join(directory.path, "folder", "note.txt")
        await Bun.write(first, "original-first")
        await Bun.write(nested, "original-nested")
        const hash = (await Snapshot.track("restore-parent"))!
        await Bun.write(first, "keep-first")
        await Bun.write(path.join(external.path, "note.txt"), "keep-external")
        await fs.rm(path.dirname(nested), { recursive: true })
        await fs.symlink(external.path, path.dirname(nested))
        await expect(
          Snapshot.revert([{ hash, workspace: Snapshot.workspace()!, files: [first, nested] }], "restore-parent"),
        ).rejects.toThrow()
        expect(await Bun.file(first).text()).toBe("keep-first")
        expect(await Bun.file(path.join(external.path, "note.txt")).text()).toBe("keep-external")
      },
    })
  }))

test("native restoration retains executable mode and symbolic link text", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const executable = path.join(directory.path, "run.sh"),
          link = path.join(directory.path, "link")
        await Bun.write(executable, "#!/bin/sh\nexit 0\n")
        await fs.chmod(executable, 0o755)
        await fs.symlink("missing target", link)
        const hash = (await Snapshot.track("restore-mode"))!
        await Bun.write(executable, "changed")
        await fs.chmod(executable, 0o644)
        await fs.unlink(link)
        await Bun.write(link, "ordinary file")
        const result = await Snapshot.revert(
          [{ hash, workspace: Snapshot.workspace()!, files: [executable, link] }],
          "restore-mode",
        )
        expect(result.failedFiles).toEqual([])
        expect((await fs.stat(executable)).mode & 0o111).toBe(0o111)
        expect(await fs.readlink(link)).toBe("missing target")
      },
    })
  }))

test("file restore owns and drains the session loop through cancellation", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    await ScopeContext.provide({
      scope: await directory.scope(),
      fn: async () => {
        const session = await Session.create({})
        const file = path.join(directory.path, "note.txt")
        await Bun.write(file, "original")
        const hash = (await Snapshot.track(session.id))!
        await Bun.write(file, "keep")
        const userID = Identifier.ascending("message"),
          assistantID = Identifier.ascending("message"),
          partID = Identifier.ascending("part")
        await Session.updateMessage({
          id: userID,
          sessionID: session.id,
          role: "user",
          time: { created: 1 },
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
        })
        await Session.updateMessage({
          id: assistantID,
          sessionID: session.id,
          role: "assistant",
          parentID: userID,
          time: { created: 2, completed: 3 },
          modelID: "test",
          providerID: "test",
          mode: "build",
          agent: "synergy",
          path: { cwd: directory.path, root: directory.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        await Session.updatePart({
          id: partID,
          messageID: assistantID,
          sessionID: session.id,
          type: "patch",
          hash,
          workspace: Snapshot.workspace(),
          files: [file],
        })
        const entered = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>()
        const replace = FileEntry.replace
        using hold = spyOn(FileEntry, "replace").mockImplementation(async (input) => {
          entered.resolve()
          await release.promise
          return replace(input)
        })
        const restore = SessionHistory.restoreFilesWithSignal({ sessionID: session.id, partID })
        try {
          await entered.promise
          expect(SessionManager.isRunning(session.id)).toBe(true)
          await expect(SessionHistory.restoreFilesWithSignal({ sessionID: session.id, partID })).rejects.toThrow()
          await expect(Session.updateWorkspace(session.id, null, { requireIdle: true })).rejects.toThrow()
          expect(SessionManager.signalAbort(session.id)).toBe("signaled")
          expect(SessionManager.isRunning(session.id)).toBe(true)
          release.resolve()
          const result = await restore
          expect(result.failedFiles).toMatchObject([{ file, code: "cancelled" }])
          expect(await Bun.file(file).text()).toBe("keep")
          await SessionManager.waitForIdle(session.id)
          expect(SessionManager.isRunning(session.id)).toBe(false)
        } finally {
          release.resolve()
          await restore.catch(() => {})
          await Session.remove(session.id)
        }
      },
    })
  }))
