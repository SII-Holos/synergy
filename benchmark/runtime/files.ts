import { open, rename, unlink } from "node:fs/promises"
import path from "node:path"

export async function atomicJSON(file: string, value: unknown) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  try {
    const output = await open(temporary, "wx", 0o600)
    try {
      await output.writeFile(JSON.stringify(value))
      await output.sync()
    } finally {
      await output.close()
    }
    await rename(temporary, file)
    const directory = await open(path.dirname(file), "r")
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
}
