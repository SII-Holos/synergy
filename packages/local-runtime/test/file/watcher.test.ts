import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { FileWatcher } from "../../src/file/watcher"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { GlobalBus } from "@ericsanchezok/synergy-harness/bus/global"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ScopedState } from "@ericsanchezok/synergy-harness/scope/scoped-state"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
import { waitForLinuxSubscription } from "../support/watcher"
const runtime = await testRuntime({ env: { SYNERGY_DISABLE_FILEWATCHER: "0" } })

async function withWatcher(fn: () => Promise<void>) {
  try {
    await fn()
  } finally {
    await ScopedState.disposeAll()
  }
}

test(
  "native workspace watcher publishes file changes and resumes after reload",
  () =>
    runtime.run(() =>
      withWatcher(async () => {
        await using directory = await tmpdir({ git: true })
        await ScopeContext.provide({
          scope: await directory.scope(),
          async fn() {
            await FileWatcher.init()
            await waitForLinuxSubscription(directory.path)
            const target = path.join(directory.path, "watched.txt")
            let resolveChange: ((event: string) => void) | undefined
            const unsubscribe = Bus.subscribe(FileWatcher.Event.Updated, (event) => {
              if (event.properties.file === "watched.txt") resolveChange?.(event.properties.event)
            })
            async function change(action: () => Promise<unknown>) {
              const next = new Promise<string>((resolve) => {
                resolveChange = resolve
              })
              await action()
              return next
            }
            try {
              expect(await change(() => Bun.write(target, "first"))).toBe("added")
              expect(await change(() => Bun.write(target, "second"))).toBe("changed")
              await FileWatcher.reload()
              await waitForLinuxSubscription(directory.path)
              expect(await change(() => fs.rm(target))).toBe("deleted")
            } finally {
              unsubscribe()
            }
          },
        })
      }),
    ),
  30_000,
)

test(
  "a removed native root settles initialization and can be watched after explicit reload",
  () =>
    runtime.run(() =>
      withWatcher(async () => {
        await using directory = await tmpdir({ git: true })
        const scope = await directory.scope()
        await ScopeContext.provide({ scope, fn: () => FileWatcher.init() })
        await ScopedState.disposeAll()
        const retained = directory.path + ".retained"
        await fs.rename(directory.path, retained)
        try {
          await ScopeContext.provide({
            scope,
            fn: async () => {
              await expect(FileWatcher.init()).resolves.toBeUndefined()
              await Bun.sleep(1100)
              await fs.rename(retained, directory.path)
              await FileWatcher.reload()
              await waitForLinuxSubscription(directory.path)
              const observed = Promise.withResolvers<string>()
              const unsubscribe = Bus.subscribe(FileWatcher.Event.Updated, (event) => {
                if (event.properties.file === "restored.txt") observed.resolve(event.properties.event)
              })
              try {
                await Bun.write(path.join(directory.path, "restored.txt"), "restored")
                expect(await observed.promise).toBe("added")
              } finally {
                unsubscribe()
              }
            },
          })
        } finally {
          if (await Bun.file(path.join(retained, ".git", "config")).exists()) await fs.rename(retained, directory.path)
        }
      }),
    ),
  10000,
)

test(
  "native home watcher publishes global config file changes",
  () =>
    runtime.run(() =>
      withWatcher(async () => {
        await ScopeContext.provide({
          scope: Scope.home(),
          async fn() {
            await FileWatcher.init()
            await waitForLinuxSubscription(await fs.realpath(Global.Path.config), true)
            const target = path.join(await fs.realpath(Global.Path.config), "native-watcher-probe.json")
            let resolveChange!: (scopeID: string | null) => void
            const changed = new Promise<string | null>((resolve) => {
              resolveChange = resolve
            })
            const listener = (event: {
              scopeID: string | null
              payload: { type: string; properties?: { file?: string } }
            }) => {
              if (event.payload.type === "global.config.file.changed" && event.payload.properties?.file === target)
                resolveChange(event.scopeID)
            }
            GlobalBus().on("event", listener)
            try {
              await Bun.write(target, "{}")
              expect(await changed).toBeNull()
            } finally {
              GlobalBus().off("event", listener)
              await fs.rm(target, { force: true })
            }
          },
        })
      }),
    ),
  30_000,
)

afterRuntimeTests(() => runtime.close())
