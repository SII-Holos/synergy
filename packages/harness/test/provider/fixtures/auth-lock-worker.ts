import fs from "fs/promises"
import { Auth } from "@ericsanchezok/synergy-harness/provider/api-key"

const [key, output, marker] = process.argv.slice(2)
if (!key || !output || !marker) throw new Error("Expected lock key, output path, and marker")

const release = Promise.withResolvers<void>()
process.on("message", (message) => {
  if (message === "release") release.resolve()
})

try {
  if (marker === "second") process.send?.("attempting")
  await Auth.withLock(key, async () => {
    await fs.appendFile(output, `${marker}:start\n`)
    if (marker === "first") {
      process.send?.("locked")
      await release.promise
    }
    await fs.appendFile(output, `${marker}:end\n`)
  })
} finally {
  process.disconnect?.()
}
