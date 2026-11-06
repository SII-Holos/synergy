import { RuntimeHandle } from "@ericsanchezok/synergy-harness/lifecycle"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"

const list = Storage.list
let startup = true
let coldHistoryTraversals = 0
Storage.list = async (key) => {
  if (startup && key.length === 1 && key[0] === "sessions") {
    coldHistoryTraversals++
    throw new Error("Managed startup must not enumerate cold Session descendants")
  }
  return list(key)
}

const open = RuntimeHandle.open
RuntimeHandle.open = async (options) => {
  const runtime = await open(options)
  startup = false
  process.stdout.write(JSON.stringify({ coldHistoryTraversals }) + "\n")
  process.stdout.write(JSON.stringify({ fixture: "runtime-open", port: runtime.server?.port }) + "\n")
  await Bun.stdin.text()
  process.stdout.write("fixture-factory-returning\n")
  return runtime
}

const { main } = await import("../../../src/index")
await main()
