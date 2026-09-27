import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { withInstallationLock } from "./lock"

const Selection = z.object({ version: z.literal(1), roots: z.array(z.string().min(1)) }).strict()

async function hasLegacyFiles(directory: string): Promise<boolean> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  for (const entry of entries) {
    if (!entry.isDirectory() || (await hasLegacyFiles(path.join(directory, entry.name)))) return true
  }
  return false
}

export function initializeInstallationSelection(root: string, defaults: string[] = []) {
  return withInstallationLock(root, async () => {
    const file = path.join(root, "installations", "selection-v1.json")
    const existing = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (existing !== undefined) return Selection.parse(JSON.parse(existing)).roots
    const legacy = (await hasLegacyFiles(path.join(root, "config"))) || (await hasLegacyFiles(path.join(root, "data")))
    const roots = [...new Set([...defaults, ...(legacy ? ["@ericsanchezok/synergy-web"] : [])])]
    await AtomicFile.writeJsonAtomic(file, JSON.stringify({ version: 1, roots }), { durable: true, private: true })
    return roots
  })
}
