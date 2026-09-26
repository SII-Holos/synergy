import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
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
import { registerProductRuntime } from "../../src/product-registration"
import { ObservabilityStore } from "@ericsanchezok/synergy-harness/observability/store"
import { ObservabilityMetrics } from "@ericsanchezok/synergy-harness/observability/metrics"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { StorageBootstrap } from "@ericsanchezok/synergy-harness/storage/bootstrap"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
let fixture: Awaited<ReturnType<typeof runtimeHome>>
let runtime: RuntimeContext.Instance

const clackState = {
  confirmResult: true as boolean | "cancel",
  multiselectResult: [] as string[] | "cancel",
  selectFirst: true,
  textValue: "",
  passwordValue: "secret",
}

const clackModuleURL = import.meta.resolve("@clack/prompts")
mock.module(clackModuleURL, () => ({
  intro: () => {},
  outro: () => {},
  log: { info: () => {}, success: () => {}, warn: () => {}, error: () => {}, message: () => {} },
  cancel: () => {},
  note: () => {},
  isCancel: (value: unknown) => value === "cancel" || value === undefined,
  spinner: () => ({ start: () => {}, message: () => {}, stop: () => {} }),
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
    registerProductRuntime()
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
