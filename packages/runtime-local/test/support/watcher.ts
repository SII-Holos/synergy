import fs from "node:fs/promises"
import path from "node:path"
import { FileWatcher } from "../../src/file/watcher"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { GlobalBus } from "@ericsanchezok/synergy-harness/bus/global"

export async function waitForLinuxSubscription(directory: string, home = false) {
  if (process.platform !== "linux") return
  const target = path.join(directory, ".native-watcher-ready")
  let ready!: () => void
  const observed = new Promise<void>((resolve) => {
    ready = resolve
  })
  let deleted!: () => void
  const removed = new Promise<void>((resolve) => {
    deleted = resolve
  })
  const off = Bus.subscribe(FileWatcher.Event.Updated, (event) => {
    if (home || event.properties.absolute !== target) return
    if (event.properties.event === "deleted") deleted()
    else ready()
  })
  const listener = (event: { payload: { properties?: { file?: string } } }) => {
    if (home && event.payload.properties?.file === target) ready()
  }
  GlobalBus().on("event", listener)
  // Linux publishes scope state before its uncancellable native scan settles.
  // Use a received native event as the readiness barrier, not a startup delay.
  let pendingWrite = Promise.resolve(0)
  const pulse = setInterval(() => {
    pendingWrite = pendingWrite.then(() => Bun.write(target, String(Date.now())))
  }, 25)
  try {
    await observed
  } finally {
    clearInterval(pulse)
    try {
      await pendingWrite
      await fs.rm(target, { force: true })
      if (!home) await removed
    } finally {
      off()
      GlobalBus().off("event", listener)
    }
  }
}
