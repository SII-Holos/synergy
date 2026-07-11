import path from "path"
import fs from "fs/promises"
import os from "os"
import { Global } from "../global"
import { PluginLockfile } from "./lockfile-schema"
import type { PluginLockEntry } from "./lockfile-schema"

const EMPTY_LOCKFILE: PluginLockfile = {
  version: 2 as const,
  plugins: {},
}

function lockfilePath() {
  return path.join(Global.Path.root, "plugin.lock")
}

/**
 * Read and parse the plugin lockfile.
 * Returns an empty lockfile if the file doesn't exist.
 */
export async function read(): Promise<PluginLockfile> {
  try {
    const text = await Bun.file(lockfilePath()).text()
    if (!text.trim()) return { ...EMPTY_LOCKFILE }
    const parsed = PluginLockfile.parse(JSON.parse(text))
    return parsed
  } catch (err: any) {
    if (err.code === "ENOENT") return { ...EMPTY_LOCKFILE }
    throw err
  }
}

/**
 * Write the lockfile atomically (write to temp + rename).
 */
export async function write(lockfile: PluginLockfile): Promise<void> {
  const targetPath = lockfilePath()
  const tmpPath = path.join(os.tmpdir(), `.synergy-plugin-lock-${Date.now()}.tmp`)
  await Bun.write(tmpPath, JSON.stringify(lockfile, null, 2) + "\n")
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.rename(tmpPath, targetPath)
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
