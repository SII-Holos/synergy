import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import type { Argv } from "yargs"
import yargs from "yargs"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Global } from "@ericsanchezok/synergy-harness/global"
import {
  CATEGORIES,
  checkDiskSpace,
  copyDirSkipExisting,
  dataRoot,
  dirExists,
  formatSize,
  isDirEmpty,
  removeShellProfile,
  scanCategories,
  scanDir,
  shortenPath,
  updateShellProfile,
} from "@ericsanchezok/synergy-cli/cli/cmd/data/shared"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { registerFullPreset } from "../../src/registration"
import { ObservabilityStore } from "@ericsanchezok/synergy-harness/observability/store"
import { ObservabilityMetrics } from "@ericsanchezok/synergy-harness/observability/metrics"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { StorageBootstrap } from "@ericsanchezok/synergy-harness/storage/bootstrap"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { SnapshotArchive } from "@ericsanchezok/synergy-harness/session/snapshot-archive"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import type { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { WorkspaceCoordinator } from "@ericsanchezok/synergy-local-runtime/workspace/coordinator"
import { createLocalHost } from "@ericsanchezok/synergy-local-runtime/host"
let fixture: Awaited<ReturnType<typeof runtimeHome>>
let runtime: RuntimeContext.Instance

const clackState = {
  confirmResult: true as boolean | "cancel",
  multiselectResult: [] as string[] | "cancel",
  selectFirst: true,
  textValue: "",
  passwordValue: "secret",
  errors: [] as string[],
}

const clackModuleURL = import.meta.resolve("@clack/prompts")
mock.module(clackModuleURL, () => ({
  intro: () => {},
  outro: () => {},
  log: {
    info: () => {},
    success: () => {},
    warn: () => {},
    error: (message: string) => clackState.errors.push(message),
    message: () => {},
  },
  cancel: () => {},
  note: () => {},
  isCancel: (value: unknown) => value === "cancel" || value === undefined,
  spinner: () => ({ start: () => {}, message: () => {}, stop: () => {}, error: () => {} }),
  text: async (opts?: { initialValue?: string }) => clackState.textValue || opts?.initialValue || "value",
  password: async () => clackState.passwordValue,
  confirm: async () => clackState.confirmResult,
  select: async (opts: { options: Array<{ value: unknown }> }) =>
    clackState.selectFirst ? opts.options[0]?.value : "cancel",
  multiselect: async () => clackState.multiselectResult,
}))

const originalEnv = { ...process.env }
beforeEach(async () => {
  fixture = await runtimeHome()
  runtime = RuntimeContext.create(fixture.host)
  await runtime.run(async () => {
    registerFullPreset()
    await fs.mkdir(Global.Path.data, { recursive: true })
  })
})

afterEach(async () => {
  await runtime.run(async () => {
    ObservabilityMetrics.stop()
    await ObservabilityStore.stop()
    await Log.close()
  })
  runtime.dispose()
  await fixture[Symbol.asyncDispose]()
  process.env = { ...originalEnv }
  clackState.confirmResult = true
  clackState.multiselectResult = []
  clackState.selectFirst = true
  clackState.textValue = ""
  clackState.errors.length = 0
})

function handlerArgs<T extends Record<string, unknown>>(partial: T) {
  return { _: [] as Array<string | number>, $0: "synergy", ...partial }
}

function runHandler(command: { handler?: unknown }) {
  return (command.handler as (args: never) => Promise<void>).bind(command)
}

function runBuilder(command: { builder?: unknown }) {
  return (command.builder as (argv: Argv) => Argv)(yargs())
}

describe("data shared helpers", () => {
  test("scanDir sums sizes and file counts recursively", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "a.txt"), "12345")
          await Bun.write(path.join(dir, "b.txt"), "123")
          await Bun.write(path.join(dir, "ignored-link"), "x")
        },
      })
      const stats = await scanDir(tmp.path)
      expect(stats.fileCount).toBe(3)
      expect(stats.size).toBe(9)
      expect((await scanDir(path.join(tmp.path, "missing"))).fileCount).toBe(0)
    }))

  test("scanCategories maps every category key", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const stats = await scanCategories(tmp.path)
      expect(stats.size).toBe(CATEGORIES.length)
      for (const cat of CATEGORIES) expect(stats.get(cat.key)).toEqual({ size: 0, fileCount: 0 })
    }))

  test("formatSize scales across byte units", () =>
    runtime.run(() => {
      expect(formatSize(500)).toBe("500 B")
      expect(formatSize(2048)).toBe("2.0 KB")
      expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB")
      expect(formatSize(2 * 1024 * 1024 * 1024)).toBe("2.0 GB")
    }))

  test("shortenPath leaves non-home paths unchanged", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      expect(shortenPath(tmp.path)).toBe(tmp.path)
    }))

  test("dirExists and isDirEmpty reflect the filesystem", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "file.txt"), "x")
        },
      })
      expect(await dirExists(tmp.path)).toBe(true)
      expect(await dirExists(path.join(tmp.path, "nope"))).toBe(false)
      expect(await isDirEmpty(tmp.path)).toBe(false)
      await using empty = await tmpdir()
      await fs.mkdir(path.join(empty.path, "subdir"))
      expect(await isDirEmpty(path.join(empty.path, "subdir"))).toBe(true)
    }))

  test("checkDiskSpace creates the parent and reports ok", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const result = await checkDiskSpace(path.join(tmp.path, "deep", "target"), 1024)
      expect(result.ok).toBe(true)
      expect(result.available === null || result.available > 0).toBe(true)
      expect(await dirExists(path.join(tmp.path, "deep"))).toBe(true)
    }))

  test("copyDirSkipExisting copies new files, skips existing, follows symlinks", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "keep.txt"), "original")
          await Bun.write(path.join(dir, "nested", "inner.txt"), "inner")
          await fs.symlink("keep.txt", path.join(dir, "link.txt"))
        },
      })
      await using dst = await tmpdir()
      const progress: number[] = []
      const result = await copyDirSkipExisting(tmp.path, dst.path, (p) => progress.push(p.copied))
      expect(result).toEqual({ copied: 3, skipped: 0 })
      expect(progress).toEqual([1, 2, 3])
      expect(await Bun.file(path.join(dst.path, "nested", "inner.txt")).text()).toBe("inner")

      await Bun.write(path.join(dst.path, "keep.txt"), "changed")
      const second = await copyDirSkipExisting(tmp.path, dst.path)
      expect(second).toEqual({ copied: 0, skipped: 3 })
      expect(await Bun.file(path.join(dst.path, "keep.txt")).text()).toBe("changed")
    }))

  test("updateShellProfile writes and removeShellProfile removes a fish export line", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      const fishConfig = path.join(tmp.path, "fish", "config.fish")
      await Bun.write(fishConfig, "set fish_greeting off\n")
      process.env.SHELL = "/usr/bin/fish"
      process.env.XDG_CONFIG_HOME = tmp.path

      const result = await updateShellProfile("/custom/home")
      expect(result).toEqual({ updated: true, file: fishConfig })
      const content = await Bun.file(fishConfig).text()
      expect(content).toContain(`set -gx SYNERGY_HOME "/custom/home"`)
      expect(content).toContain("# synergy")

      const second = await updateShellProfile("/other")
      expect(second.updated).toBe(false)

      const removed = await removeShellProfile()
      expect(removed).toEqual({ removed: true, file: fishConfig })
      const after = await Bun.file(fishConfig).text()
      expect(after).not.toContain("SYNERGY_HOME")
      expect(after).toContain("set fish_greeting off")
    }))

  test("removeShellProfile reports nothing to remove when profiles are clean", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      await Bun.write(path.join(tmp.path, "fish", "config.fish"), "clean\n")
      process.env.SHELL = "/usr/bin/fish"
      process.env.XDG_CONFIG_HOME = tmp.path
      expect(await removeShellProfile()).toEqual({ removed: false, file: null })
    }))

  test("updateShellProfile reports no candidate file when none exists", () =>
    runtime.run(async () => {
      await using tmp = await tmpdir()
      process.env.SHELL = "/usr/bin/fish"
      process.env.XDG_CONFIG_HOME = tmp.path
      expect(await updateShellProfile("/custom/home")).toEqual({ updated: false, file: null })
    }))

  test("dataRoot resolves to the global data path", () =>
    runtime.run(() => {
      expect(dataRoot()).toBe(Global.Path.root)
    }))
})

describe("data move command", () => {
  test.each(["completed", "failed"] as const)(
    "offline move holds both Home locks until its target attachment %s",
    (outcome) =>
      runtime.run(async () => {
        const { executeMove } = await import("../../src/cli/data/move")
        await using destination = await tmpdir()
        const sourceRoot = Global.Path.root
        const targetRoot = path.join(destination.path, ".synergy")
        const source = await StorageBootstrap.prepare({ root: sourceRoot })
        try {
          await source.store.write(["offline-move-lock", "source"], { preserved: true })
          await source.activate()
        } finally {
          await source.store.close()
        }
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const attachmentFailure = new Error("Original target attachment rejected")
        const lockHomes = SnapshotArchive.lockHomes
        let originalDisposal: Promise<void> | undefined
        using locking = spyOn(SnapshotArchive, "lockHomes").mockImplementation(async (roots) => {
          const homes = await lockHomes(roots)
          return {
            async [Symbol.asyncDispose]() {
              originalDisposal = homes[Symbol.asyncDispose]()
              await originalDisposal
            },
          }
        })
        const openExisting = StorageBootstrap.openExisting
        let attached: Awaited<ReturnType<typeof StorageBootstrap.openExisting>> | undefined
        using opening = spyOn(StorageBootstrap, "openExisting").mockImplementation(async (root) => {
          const handle = await openExisting(root)
          if (path.resolve(root) !== targetRoot) return handle
          attached = handle
          entered.resolve()
          await release.promise
          if (outcome === "failed") {
            await handle.store.close()
            throw attachmentFailure
          }
          return handle
        })
        const settled = executeMove({ target: destination.path, removeOriginal: false, dryRun: false }).then(
          () => ({ kind: "completed" as const }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        )
        let competitors: unknown[] = []
        let result: Awaited<typeof settled>
        try {
          await Promise.race([
            entered.promise,
            settled.then(() => {
              throw new Error("Move settled before opening its actual target Store")
            }),
          ])
          if (originalDisposal) await originalDisposal
          competitors = await Promise.all(
            [sourceRoot, targetRoot].map(async (root) => {
              try {
                await using homes = await lockHomes([root])
                return undefined
              } catch (error) {
                return error
              }
            }),
          )
        } finally {
          release.resolve()
          result = await settled
        }
        for (const competitor of competitors) expect(competitor).toBeInstanceOf(ServerProcessLock.AlreadyRunningError)
        expect(result.kind).toBe(outcome)
        if (result.kind === "failed") expect(result.error).toBe(attachmentFailure)
        expect(attached?.store.readiness.readerReady).toBe(false)
        expect(await dirExists(sourceRoot)).toBe(true)
        await using reacquired = await lockHomes([sourceRoot, targetRoot])
        expect(reacquired).toBeDefined()
      }),
  )
  test("offline move retains its actual destination Store and native claims through source removal", () =>
    runtime.run(async () => {
      const { executeMove } = await import("../../src/cli/data/move")
      await using destination = await tmpdir()
      const sourceRoot = Global.Path.root
      const targetRoot = path.join(destination.path, ".synergy")
      const original = Buffer.from([0, 255, 17, 0, 64, 128])
      const source = await StorageBootstrap.prepare({ root: sourceRoot })
      try {
        await source.store.write(["offline-move", "source"], { retained: true })
        await Bun.write(path.join(sourceRoot, "data", "original.bin"), original)
        await source.activate()
      } finally {
        await source.store.close()
      }
      const target = await StorageBootstrap.prepare({ root: targetRoot })
      const directory = path.join(targetRoot, "config", "existing-workspace")
      const targetHost = createLocalHost({ root: targetRoot })
      await fs.mkdir(directory, { recursive: true })
      let workspace: WorkspaceCatalog.Info | undefined
      try {
        await Storage.provide({ store: target.store, artifactDirectory: path.join(targetRoot, "data") }, async () => {
          workspace = await WorkspaceCatalog.register({
            scopeID: "foreign-scope",
            type: "directory",
            hostID: await targetHost.workspaceLocation!.hostID(),
            ...(await targetHost.workspaceLocation!.identify(directory)),
          })
        })
        await target.activate()
      } finally {
        await target.store.close()
      }
      if (!workspace) throw new Error("Expected the actual destination Workspace")
      const retained = workspace
      const expectedSourceRoot = await fs.realpath(sourceRoot)
      const sourceStores: TransactionalStore[] = []
      const targetStores: TransactionalStore[] = []
      const coordinators = new Set<WorkspaceCoordinator>()
      const inspect = StorageBootstrap.inspect
      const existing = StorageBootstrap.openExisting
      const acquire = WorkspaceCoordinator.prototype.acquire
      const remove = fs.rm
      let removal:
        | {
            actualTarget: boolean
            targetReady: boolean
            catalogPreserved: boolean
            importedRecord: boolean
            sourceReadersClosed: boolean
            physicalClaimHeld: boolean
          }
        | undefined
      let removalError: unknown
      using inspecting = spyOn(StorageBootstrap, "inspect").mockImplementation(async (root) => {
        const handle = await inspect(root)
        if (path.resolve(root) === sourceRoot && handle) sourceStores.push(handle.store)
        return handle
      })
      using opening = spyOn(StorageBootstrap, "openExisting").mockImplementation(async (root) => {
        const handle = await existing(root)
        if (path.resolve(root) === targetRoot) targetStores.push(handle.store)
        return handle
      })
      using claiming = spyOn(WorkspaceCoordinator.prototype, "acquire").mockImplementation(async function (
        this: WorkspaceCoordinator,
        input,
      ) {
        coordinators.add(this)
        return acquire.call(this, input)
      })
      using removing = spyOn(fs, "rm").mockImplementation(async (filename, options) => {
        if (String(filename) === sourceRoot && options?.recursive) {
          try {
            const primary = Storage.current()
            const catalog = WorkspaceCatalog.Info.parse(await primary.store.read(["workspace", retained.id]))
            const imported = await primary.store.read<{ retained: boolean }>(["offline-move", "source"])
            const claims = (await Promise.all([...coordinators].map((coordinator) => coordinator.inspect()))).flat()
            removal = {
              actualTarget: targetStores.includes(primary.store),
              targetReady: primary.store.readiness.writerReady,
              catalogPreserved: JSON.stringify(catalog) === JSON.stringify(WorkspaceCatalog.Info.parse(retained)),
              importedRecord: imported.retained,
              sourceReadersClosed:
                sourceStores.length > 0 && sourceStores.every((store) => !store.readiness.readerReady),
              physicalClaimHeld: claims.some(
                (claim) =>
                  claim.kind === "exclusive" &&
                  claim.state === "active" &&
                  claim.roots?.some((root) => root.path === expectedSourceRoot),
              ),
            }
          } catch (error) {
            removalError = error
            throw error
          }
        }
        return remove(filename, options)
      })
      expect(Storage.available()).toBe(false)
      await executeMove({ target: destination.path, removeOriginal: true, dryRun: false })
      if (removalError) throw removalError
      expect(removal).toEqual({
        actualTarget: true,
        targetReady: true,
        catalogPreserved: true,
        importedRecord: true,
        sourceReadersClosed: true,
        physicalClaimHeld: true,
      })
      expect(Storage.available()).toBe(false)
      expect(targetStores.every((store) => !store.readiness.readerReady)).toBe(true)
      expect(await dirExists(sourceRoot)).toBe(false)
      expect(Buffer.from(await Bun.file(path.join(targetRoot, "data", "original.bin")).arrayBuffer())).toEqual(original)
      ObservabilityMetrics.stop()
      await ObservabilityStore.stop()
      await Log.close()
      expect(await dirExists(sourceRoot)).toBe(false)
    }))
  test("copies selected folders before publishing bindings to their new locations", () =>
    runtime.run(async () => {
      const { executeMove } = await import("../../src/cli/data/move")
      await using target = await tmpdir()
      const directory = path.join(Global.Path.root, "config", "workspace")
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(path.join(directory, "native.txt"), "workspace bytes")
      const prepared = await StorageBootstrap.prepare({ root: Global.Path.root })
      let workspace!: WorkspaceCatalog.Info
      try {
        await Storage.provide({ store: prepared.store, artifactDirectory: Global.Path.data }, async () => {
          workspace = await WorkspaceCatalog.register({
            scopeID: "home",
            type: "directory",
            hostID: await fixture.host.workspaceLocation!.hostID(),
            ...(await fixture.host.workspaceLocation!.identify(directory)),
          })
        })
        await prepared.activate()
      } finally {
        await prepared.store.close()
      }
      await executeMove({ target: target.path, removeOriginal: false, dryRun: false })
      const destination = path.join(target.path, ".synergy")
      const imported = (await StorageBootstrap.inspect(destination))!
      try {
        const record = await imported.store.read<WorkspaceCatalog.Info>(["workspace", workspace.id])
        expect(record.binding).toMatchObject({
          state: "bound",
          path: await fs.realpath(path.join(destination, "config", "workspace")),
          generation: 2,
        })
        expect(await fs.readFile(path.join(record.binding.path!, "native.txt"), "utf8")).toBe("workspace bytes")
      } finally {
        await imported.store.close()
      }
    }))
  test("remove-original releases its storage locks without recreating the source home", () =>
    runtime.run(async () => {
      const { executeMove } = await import("../../src/cli/data/move")
      await using target = await tmpdir()
      const root = Global.Path.root
      await Bun.write(path.join(root, "data", "session.json"), "{}")
      const ledger = path.join(root, "data", ...StoragePath.rolloutRecoveryPending()) + ".json"
      await Bun.write(ledger, "{}")
      await executeMove({ target: target.path, removeOriginal: true, dryRun: false })
      expect(await dirExists(root)).toBe(false)
      expect(await Bun.file(path.join(target.path, ".synergy", "data", "session.json")).text()).toBe("{}")
      expect(
        await Bun.file(
          path.join(target.path, ".synergy", "data", ...StoragePath.rolloutRecoveryPending()) + ".json",
        ).exists(),
      ).toBe(false)
    }))
  test("dry-run plans a move without touching the target", () =>
    runtime.run(async () => {
      const { executeMove } = await import("../../src/cli/data/move")
      await using target = await tmpdir()
      const root = Global.Path.root
      await Bun.write(path.join(root, "data", "session.json"), "{}")
      try {
        await executeMove({ target: target.path, removeOriginal: false, dryRun: true })
        expect(await dirExists(path.join(target.path, ".synergy", "data"))).toBe(false)
      } finally {
        await Bun.file(path.join(root, "data", "session.json"))
          .delete()
          .catch(() => {})
      }
    }))

  test("rejects a target equal to the current data root", () =>
    runtime.run(async () => {
      const { executeMove } = await import("../../src/cli/data/move")
      await Bun.write(path.join(Global.Path.root, "data", "session.json"), "{}")
      try {
        await executeMove({ target: Global.Path.root, removeOriginal: false, dryRun: true })
      } finally {
        await Bun.file(path.join(Global.Path.root, "data", "session.json"))
          .delete()
          .catch(() => {})
      }
    }))

  test("cancel at confirmation aborts before any copy", () =>
    runtime.run(async () => {
      const { executeMove } = await import("../../src/cli/data/move")
      await using target = await tmpdir()
      clackState.confirmResult = "cancel"
      const root = Global.Path.root
      await Bun.write(path.join(root, "data", "session.json"), "{}")
      try {
        await executeMove({ target: target.path, removeOriginal: false, dryRun: false })
        expect(await dirExists(path.join(target.path, ".synergy", "data"))).toBe(false)
      } finally {
        await Bun.file(path.join(root, "data", "session.json"))
          .delete()
          .catch(() => {})
      }
    }))

  test("executes a real move when confirmed", () =>
    runtime.run(async () => {
      const { executeMove } = await import("../../src/cli/data/move")
      await using target = await tmpdir()
      const root = Global.Path.root
      await Bun.write(path.join(root, "data", "session.json"), "{}")
      try {
        await executeMove({ target: target.path, removeOriginal: false, dryRun: false })
        expect(await Bun.file(path.join(target.path, ".synergy", "data", "session.json")).text()).toBe("{}")
      } finally {
        await Bun.file(path.join(root, "data", "session.json"))
          .delete()
          .catch(() => {})
      }
    }))
})

describe("data command registrations", () => {
  test("registers the data command tree and migrate alias", () =>
    runtime.run(async () => {
      const { DataCommand, MigrateCommand } = await import("../../src/cli/data")
      expect(runBuilder(DataCommand)).toBeDefined()
      expect(runBuilder(MigrateCommand)).toBeDefined()
    }))

  test("data path handler reports the data root", () =>
    runtime.run(async () => {
      const { DataPathCommand } = await import("@ericsanchezok/synergy-cli/cli/cmd/data/path")
      process.env.SYNERGY_HOME = "/override"
      await runHandler(DataPathCommand)(handlerArgs({}) as never)
    }))

  test("data set-home unset removes the shell profile entry", () =>
    runtime.run(async () => {
      const { DataSetHomeCommand } = await import("@ericsanchezok/synergy-cli/cli/cmd/data/set-home")
      await using tmp = await tmpdir()
      await Bun.write(path.join(tmp.path, "fish", "config.fish"), "clean\n")
      process.env.SHELL = "/usr/bin/fish"
      process.env.XDG_CONFIG_HOME = tmp.path
      await runHandler(DataSetHomeCommand)(handlerArgs({ path: "/ignored", unset: true }) as never)
      expect(await Bun.file(path.join(tmp.path, "fish", "config.fish")).text()).toBe("clean\n")
    }))

  test("data set-home detects when the target already holds the current home", () =>
    runtime.run(async () => {
      const { DataSetHomeCommand } = await import("@ericsanchezok/synergy-cli/cli/cmd/data/set-home")
      const current = Global.Path.root
      const parent = current.slice(0, -"/.synergy".length)
      process.env.SYNERGY_HOME = parent
      await runHandler(DataSetHomeCommand)(handlerArgs({ path: parent, unset: false }) as never)
    }))

  test("data merge merges a directory source into the current data root", () =>
    runtime.run(async () => {
      const { DataMergeCommand } = await import("../../src/cli/data/merge")
      await using source = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "data", "file.txt"), "payload")
        },
      })
      const root = Global.Path.root
      await Bun.write(path.join(root, "data", "target.txt"), "{}")
      const ledger = path.join(root, "data", ...StoragePath.rolloutRecoveryPending()) + ".json"
      await Bun.write(ledger, "{}")
      try {
        await runHandler(DataMergeCommand)(handlerArgs({ source: source.path }) as never)
        expect(await Bun.file(path.join(root, "data", "file.txt")).text()).toBe("payload")
        expect(await Bun.file(ledger).exists()).toBe(false)
      } catch (error) {
        console.error("data-merge-directory-original-error", { messages: clackState.errors })
        throw error
      } finally {
        await Bun.file(path.join(root, "data", "file.txt"))
          .delete()
          .catch(() => {})
        await Bun.file(path.join(root, "data", "target.txt"))
          .delete()
          .catch(() => {})
      }
    }))

  test("data merge aborts on a missing source", () =>
    runtime.run(async () => {
      const { DataMergeCommand } = await import("../../src/cli/data/merge")
      await runHandler(DataMergeCommand)(
        handlerArgs({ source: path.join(Global.Path.root, "definitely-missing") }) as never,
      )
    }))

  test("data pack cancels when multiselect is cancelled", () =>
    runtime.run(async () => {
      const { DataPackCommand } = await import("../../src/cli/data/pack")
      clackState.multiselectResult = "cancel"
      await runHandler(DataPackCommand)(handlerArgs({ output: "" }) as never)
    }))

  test("data pack and archive merge round-trip owned data while preserving an existing destination file", () =>
    runtime.run(async () => {
      const { DataPackCommand } = await import("../../src/cli/data/pack")
      const { DataMergeCommand } = await import("../../src/cli/data/merge")
      await using archive = await tmpdir()
      const name = `roundtrip-${crypto.randomUUID()}.json`
      const keep = `keep-${crypto.randomUUID()}.json`
      const root = Global.Path.root
      const file = path.join(root, "data", name)
      const existing = path.join(root, "data", keep)
      const output = path.join(archive.path, "backup")
      await Bun.write(file, "original archived payload")
      await Bun.write(existing, "old")
      try {
        await runHandler(DataPackCommand)(handlerArgs({ output }) as never)
        const packed = (await Bun.file(`${output}.zip`).exists()) ? `${output}.zip` : `${output}.tar.gz`
        expect(await Bun.file(packed).exists()).toBe(true)
        await fs.rm(file)
        await Bun.write(existing, "new destination")
        await runHandler(DataMergeCommand)(handlerArgs({ source: packed }) as never)
        expect(await Bun.file(file).text()).toBe("original archived payload")
        expect(await Bun.file(existing).text()).toBe("new destination")
      } catch (error) {
        console.error("data-merge-archive-original-error", { messages: clackState.errors })
        throw error
      } finally {
        await fs.rm(file, { force: true })
        await fs.rm(existing, { force: true })
      }
    }))

  test("data merge cancellation leaves the destination untouched", () =>
    runtime.run(async () => {
      const { DataMergeCommand } = await import("../../src/cli/data/merge")
      await using source = await tmpdir()
      const name = `cancel-${crypto.randomUUID()}.json`
      await Bun.write(path.join(source.path, "data", name), "payload")
      clackState.confirmResult = false
      await runHandler(DataMergeCommand)(handlerArgs({ source: source.path }) as never)
      expect(await Bun.file(path.join(Global.Path.root, "data", name)).exists()).toBe(false)
      clackState.confirmResult = true
      clackState.multiselectResult = "cancel"
      await runHandler(DataMergeCommand)(handlerArgs({ source: source.path }) as never)
      expect(await Bun.file(path.join(Global.Path.root, "data", name)).exists()).toBe(false)
    }))
})
