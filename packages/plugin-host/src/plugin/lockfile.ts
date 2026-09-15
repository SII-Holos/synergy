import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { PluginLockfile } from "./lockfile-schema"
import type { PluginLockEntry } from "./lockfile-schema"

export async function read(): Promise<PluginLockfile> {
  return Storage.snapshot(async (tx) => {
    const [metadata] = await tx.readMany<Record<string, unknown>>([["plugin-lock", "info"]])
    const plugins: Record<string, PluginLockEntry> = {}
    for (const key of await tx.list(["plugin-lock", "entries"]))
      plugins[key.at(-1)!] = await tx.read<PluginLockEntry>(key)
    const document = { version: 2, ...metadata, plugins }
    PluginLockfile.loose().parse(document)
    return document as PluginLockfile
  })
}

export async function write(lockfile: PluginLockfile): Promise<void> {
  const { plugins, ...metadata } = lockfile
  await Storage.transaction(async (tx) => {
    await tx.write(["plugin-lock", "info"], metadata)
    const existing = await tx.scan(["plugin-lock", "entries"])
    for (const id of existing) if (!(id in plugins)) await tx.remove(["plugin-lock", "entries", id])
    for (const [id, entry] of Object.entries(plugins)) await tx.write(["plugin-lock", "entries", id], entry)
  })
}

/**
 * Add or replace a plugin entry in the lockfile.
 * Pure function — returns a new lockfile object.
 */
export function addEntry(lockfile: PluginLockfile, pluginName: string, entry: PluginLockEntry): PluginLockfile {
  return {
    ...lockfile,
    plugins: {
      ...lockfile.plugins,
      [pluginName]: entry,
    },
  }
}

/**
 * Remove a plugin entry from the lockfile.
 * Pure function — returns a new lockfile object.
 */
export function removeEntry(lockfile: PluginLockfile, pluginName: string): PluginLockfile {
  const { [pluginName]: _, ...rest } = lockfile.plugins
  return {
    ...lockfile,
    plugins: rest,
  }
}

export function removePluginEntries(lockfile: PluginLockfile, pluginId: string, specs: string[]): PluginLockfile {
  const removedSpecs = new Set(specs)
  return {
    ...lockfile,
    plugins: Object.fromEntries(
      Object.entries(lockfile.plugins).filter(
        ([entryId, entry]) => entryId !== pluginId && entry.approvalId !== pluginId && !removedSpecs.has(entry.spec),
      ),
    ),
  }
}

/**
 * Compute SHA-256 hash of a plugin's entry file.
 * Returns a lowercase hex string, or null if the file cannot be read.
 */
export async function computeIntegrity(entryPath: string): Promise<string | null> {
  try {
    const buffer = await Bun.file(entryPath).arrayBuffer()
    const hash = new Bun.CryptoHasher("sha256").update(new Uint8Array(buffer)).digest("hex")
    return hash
  } catch {
    return null
  }
}

/**
 * Verify a plugin entry file matches its lockfile integrity hash.
 * Returns false on mismatch or missing file/hash.
 */
export async function checkIntegrity(entry: PluginLockEntry): Promise<boolean> {
  if (!entry.integrity) return false
  const actual = await computeIntegrity(entry.resolved)
  if (!actual) return false
  return actual === entry.integrity
}
