import fs from "fs/promises"
import { Auth } from "../../../src/provider/api-key"

const [key, output, marker] = process.argv.slice(2)
if (!key || !output || !marker) throw new Error("Expected lock key, output path, and marker")

await Auth.withLock(key, async () => {
  await fs.appendFile(output, `${marker}:start\n`)
  await Bun.sleep(100)
  await fs.appendFile(output, `${marker}:end\n`)
})
