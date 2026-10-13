import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { withInstallationLock } from "./lock"
import { expandLegacyComponentSelection } from "./selection-upgrade"

const Selection = z.object({ version: z.literal(1), roots: z.array(z.string().min(1)) }).strict()
const SelectionV2 = Selection.extend({ version: z.literal(2) })

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

async function initialSelection(root: string, defaults: string[]) {
  const file = path.join(root, "installations", "selection-v1.json")
  const existing = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing !== undefined) return { roots: Selection.parse(JSON.parse(existing)).roots, existing: true }
  const legacy = (await hasLegacyFiles(path.join(root, "config"))) || (await hasLegacyFiles(path.join(root, "data")))
  const roots = [...new Set([...defaults, ...(legacy ? ["@ericsanchezok/synergy-web"] : [])])]
  await AtomicFile.writeJsonAtomic(file, JSON.stringify({ version: 1, roots }), { durable: true, private: true })
  return { roots, existing: false }
}

export function initializeInstallationSelection(root: string, defaults: string[] = []) {
  return withInstallationLock(root, async () => (await initialSelection(root, defaults)).roots)
}

export function upgradeInstallationSelection(root: string, defaults: string[] = [], authoritative?: string[]) {
  return withInstallationLock(root, async () => {
    const initial = await initialSelection(root, defaults)
    const file = path.join(root, "installations", "selection-v2.json")
    const existing = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (existing !== undefined) return SelectionV2.parse(JSON.parse(existing)).roots
    const selected = authoritative ?? (initial.existing ? expandLegacyComponentSelection(initial.roots) : initial.roots)
    await AtomicFile.writeJsonAtomic(file, JSON.stringify({ version: 2, roots: selected }), {
      durable: true,
      private: true,
    })
    return selected
  })
}
