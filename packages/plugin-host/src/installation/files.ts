import fs from "node:fs/promises"
import { createHash } from "node:crypto"

export async function sha256File(filename: string, durable = false) {
  const hash = createHash("sha256")
  const reader = Bun.file(filename).stream().getReader()
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      hash.update(result.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  if (durable) {
    const file = await fs.open(filename, "r")
    try {
      await file.sync()
    } finally {
      await file.close()
    }
  }
  return hash.digest("hex")
}
