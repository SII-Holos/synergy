import path from "path"
import { Log } from "../util/log"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import type { PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"

const log = Log.create({ service: "plugin.manifest-reader" })

/**
 * Read and validate plugin.json from an installed plugin directory.
 *
 * Returns the parsed manifest if valid.
 * Returns null if plugin.json doesn't exist (legacy plugins without a manifest).
 * Throws if plugin.json exists but is malformed.
 */
export async function read(pluginDir: string): Promise<PluginManifestType | null> {
  const manifestPath = path.join(pluginDir, "plugin.json")

  let text: string
  try {
    text = await Bun.file(manifestPath).text()
  } catch (err: any) {
    if (err.code === "ENOENT") return null
    throw err
  }

  if (!text.trim()) return null

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`Invalid JSON in plugin manifest: ${manifestPath}`)
  }

  const parsed = PluginManifest.safeParse(raw)
  if (!parsed.success) {
    log.warn("invalid plugin manifest", {
      path: manifestPath,
      issues: parsed.error.issues,
    })
    throw new Error(
      `Invalid plugin manifest at ${manifestPath}: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
    )
  }

  return parsed.data as PluginManifestType
}
