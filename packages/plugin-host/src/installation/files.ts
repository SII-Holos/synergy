import fs from "node:fs/promises"
import { createHash } from "node:crypto"

export async function sha256File(filename: string, durable = false) {
  const file = await fs.open(filename, "r")
  try {
    const hash = createHash("sha256")
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
    if (durable) await file.sync()
    return hash.digest("hex")
  } finally {
    await file.close()
  }
}
