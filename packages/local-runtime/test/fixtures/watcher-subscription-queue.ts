import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import { FileWatcherBinding } from "../../src/file/watcher-binding"
import { FileWatcherEvents } from "../../src/file/watcher-events"

const directory = await mkdtemp(path.join(tmpdir(), "watcher-subscription-queue-"))
await rm(directory, { recursive: true })
const watcher = createWrapper(FileWatcherBinding.load())
const enqueue = FileWatcherEvents.createSubscriptionQueue()
let active = 0
let maximum = 0
let rejected = 0
await Promise.all(
  Array.from({ length: 4 }, async (_, worker) => {
    for (let index = 0; index < 100; index++) {
      const start = async () => {
        maximum = Math.max(maximum, ++active)
        try {
          return await watcher.subscribe(path.join(directory, String(worker)), () => {}, { backend: "fs-events" })
        } finally {
          active--
        }
      }
      try {
        await (process.argv.includes("--unsafe") ? start() : enqueue(start, (pending) => pending))
      } catch {
        rejected++
      }
    }
  }),
)
console.log(JSON.stringify({ rejected, maximum }))
