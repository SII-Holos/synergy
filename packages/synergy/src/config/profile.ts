import path from "path"
import fs from "fs/promises"
import { mergeDeep } from "remeda"
import { Global } from "../global"
import { Log } from "../util/log"
import type { ProfileMeta } from "./profile-schema"

const log = Log.create({ service: "config.profile" })

type ConfigObject = Record<string, unknown>

function profilesDir(): string {
  return path.join(Global.Path.config, "profiles")
}

function profilePath(name: string): string {
  return path.join(profilesDir(), name, "synergy.jsonc")
}

function profileMetaPath(name: string): string {
  return path.join(profilesDir(), name, "meta.json")
}

/**
 * List all profiles with their metadata.
 */
export async function list(): Promise<ProfileMeta[]> {
  await fs.mkdir(profilesDir(), { recursive: true })
  const entries = await fs.readdir(profilesDir(), { withFileTypes: true }).catch(() => [])
  const dirs = entries.filter((e) => e.isDirectory())

  const results: ProfileMeta[] = []
  for (const dir of dirs) {
    const meta = await readMeta(dir.name)
    results.push({
      name: dir.name,
      inherits: meta?.inherits,
      description: meta?.description,
    })
  }

  return results.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Create a new profile directory with an initial config.
 */
export async function create(name: string, meta: ProfileMeta): Promise<void> {
  const dir = path.join(profilesDir(), name)
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(profileMetaPath(name), JSON.stringify(meta, null, 2) + "\n")
  // Only create synergy.jsonc if it doesn't exist (so create is idempotent wrt config)
  try {
    await fs.access(profilePath(name))
  } catch {
    await Bun.write(profilePath(name), "{}\n")
  }
  log.info("created profile", { name })
}

/**
 * Activate a profile — set it as the active profile.
 * This writes the active profile name to global state so Config.state()
 * can use it during config resolution.
 */
export async function activate(name: string): Promise<void> {
  await fs.mkdir(Global.Path.state, { recursive: true })
  const statePath = path.join(Global.Path.state, "active-profile")
  await Bun.write(statePath, name + "\n")
  log.info("activated profile", { name })
}

/**
 * Get the name of the currently active profile, if any.
 */
export async function activeName(): Promise<string | undefined> {
  const statePath = path.join(Global.Path.state, "active-profile")
  try {
    const text = await Bun.file(statePath).text()
    return text.trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve a profile's config by walking the inheritance chain.
 * Merges in order: parent → child (child overrides parent).
 * Detects and rejects inheritance cycles.
 */
export async function resolve(name: string, visited = new Set<string>()): Promise<ConfigObject> {
  if (visited.has(name)) {
    const chain = [...visited, name].join(" → ")
    throw new Error(`Profile inheritance cycle detected: ${chain}`)
  }
  visited.add(name)
  const meta = await readMeta(name)
  let result: ConfigObject = {}

  // Walk inheritance chain: load parent first, then child on top
  if (meta?.inherits) {
    result = await resolve(meta.inherits, visited)
  }

  try {
    const text = await Bun.file(profilePath(name)).text()
    if (text.trim()) {
      const parsed = JSON.parse(text) as ConfigObject
      result = mergeDeep(result, parsed) as ConfigObject
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      log.warn("failed to load profile config", {
        name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}

async function readMeta(name: string): Promise<ProfileMeta | null> {
  try {
    const text = await Bun.file(profileMetaPath(name)).text()
    if (!text.trim()) return null
    const parsed = JSON.parse(text)
    return {
      name: parsed.name ?? name,
      inherits: parsed.inherits,
      description: parsed.description,
    }
  } catch (err: any) {
    if (err.code === "ENOENT") return null
    log.warn("failed to read profile meta", {
      name,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
