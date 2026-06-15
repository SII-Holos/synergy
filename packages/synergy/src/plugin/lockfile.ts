import path from "path"
import fs from "fs/promises"
import os from "os"
import { Global } from "../global"
import { PluginLockfile } from "./lockfile-schema"
import type { PluginLockEntry } from "./lockfile-schema"
const lockfilePath = path.join(Global.Path.root, "plugin.lock")

const EMPTY_LOCKFILE: PluginLockfile = {
  version: 1 as const,
  plugins: {},
}

/**
 * Read and parse the plugin lockfile.
 * Returns an empty lockfile if the file doesn't exist.
 */
export async function read(): Promise<PluginLockfile> {
  try {
    const text = await Bun.file(lockfilePath).text()
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
  const tmpPath = path.join(os.tmpdir(), `.synergy-plugin-lock-${Date.now()}.tmp`)
  await Bun.write(tmpPath, JSON.stringify(lockfile, null, 2) + "\n")
  await fs.mkdir(path.dirname(lockfilePath), { recursive: true })
  await fs.rename(tmpPath, lockfilePath)
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
 * Verify installed plugin files match the lockfile integrity hash.
 * Currently a stub that always returns true — integrity checking is a future feature.
 */
export async function checkIntegrity(
  _lockfile: PluginLockfile,
  _pluginName: string,
  _installPath: string,
): Promise<boolean> {
  return true
}
