import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { FileWatcher } from "../../src/file/watcher"
import { Flag } from "@ericsanchezok/synergy-harness/flag/flag"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { GlobalBus } from "@ericsanchezok/synergy-harness/bus/global"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ScopedState } from "@ericsanchezok/synergy-harness/scope/scoped-state"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

async function withWatcher(fn: () => Promise<void>) {
  const disabled = Object.getOwnPropertyDescriptor(Flag, "SYNERGY_DISABLE_FILEWATCHER")!
  Object.defineProperty(Flag, "SYNERGY_DISABLE_FILEWATCHER", { ...disabled, value: false })
  try {
    await fn()
  } finally {
    await ScopedState.disposeAll()
    Object.defineProperty(Flag, "SYNERGY_DISABLE_FILEWATCHER", disabled)
  }
}

async function waitForLinuxSubscription(directory: string, home = false) {
  if (process.platform !== "linux") return
  const target = path.join(directory, ".native-watcher-ready")
  let ready!: () => void
  const observed = new Promise<void>((resolve) => {
    ready = resolve
  })
  const off = Bus.subscribe(FileWatcher.Event.Updated, (event) => {
    if (!home && event.properties.absolute === target) ready()
  })
  const listener = (event: { payload: { properties?: { file?: string } } }) => {
    if (home && event.payload.properties?.file === target) ready()
  }
  GlobalBus.on("event", listener)
  // Linux publishes scope state before its uncancellable native scan settles.
  // Use a received native event as the readiness barrier, not a startup delay.
  const pulse = setInterval(() => {
    void Bun.write(target, String(Date.now()))
  }, 25)
  try {
    await observed
  } finally {
    clearInterval(pulse)
    off()
    GlobalBus.off("event", listener)
    await fs.rm(target, { force: true })
  }
}

test(
  "native workspace watcher publishes file changes and resumes after reload",
  () =>
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
  30_000,
)

test(
  "native home watcher publishes global config file changes",
  () =>
    withWatcher(async () => {
      await ScopeContext.provide({
        scope: Scope.home(),
        async fn() {
          await FileWatcher.init()
          await waitForLinuxSubscription(await fs.realpath(Global.Path.config), true)
          const target = path.join(await fs.realpath(Global.Path.config), "native-watcher-probe.json")
          let resolveChange!: (directory: string) => void
          const changed = new Promise<string>((resolve) => {
            resolveChange = resolve
          })
          const listener = (event: {
            directory?: string
            payload: { type: string; properties?: { file?: string } }
          }) => {
            if (event.payload.type === "global.config.file.changed" && event.payload.properties?.file === target)
              resolveChange(event.directory ?? "")
          }
          GlobalBus.on("event", listener)
          try {
            await Bun.write(target, "{}")
            expect(await changed).toBe("global")
          } finally {
            GlobalBus.off("event", listener)
            await fs.rm(target, { force: true })
          }
        },
      })
    }),
  30_000,
)
