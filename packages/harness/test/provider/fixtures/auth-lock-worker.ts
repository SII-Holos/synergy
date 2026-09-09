import fs from "fs/promises"
import { authLockDirectory, fileLockPath } from "@ericsanchezok/synergy-util/fs-lock"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { Auth } from "@ericsanchezok/synergy-harness/provider/api-key"

const [key, output, marker] = process.argv.slice(2)
if (!key || !output || !marker) throw new Error("Expected lock key, output path, and marker")

const release = Promise.withResolvers<void>()
process.on("message", (message) => {
  if (message === "release") release.resolve()
})

const open = fs.open
if (marker === "second") {
  const lockPath = fileLockPath(authLockDirectory(Global.Path.root), key)
  fs.open = async (...args) => {
    try {
      return await open(...args)
    } catch (error) {
      if (args[0] === lockPath && args[1] === "wx" && (error as NodeJS.ErrnoException).code === "EEXIST") {
        process.send?.("contended")
      }
      throw error
    }
  }
}

try {
  await Auth.withLock(key, async () => {
    await fs.appendFile(output, `${marker}:start\n`)
    if (marker === "first") {
      process.send?.("locked")
      await release.promise
    }
    await fs.appendFile(output, `${marker}:end\n`)
  })
} finally {
  fs.open = open
  process.disconnect?.()
}
