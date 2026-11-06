import fs from "node:fs/promises"
import path from "node:path"

export namespace FileOwnership {
  export type Owner = { uid: number; gid: number }

  export async function mkdir(directory: string, options: { mode?: number; owner?: Owner } = {}) {
    const first = await fs.mkdir(directory, { recursive: true, mode: options.mode })
    if (!first || !options.owner) return
    for (let current = directory; ; current = path.dirname(current)) {
      await fs.chown(current, options.owner.uid, options.owner.gid)
      if (current === first) break
    }
  }
}
