import {
  hasBundledSolidRuntime,
  hasUnsupportedSolidRuntimeImport,
  hasUnlinkedSolidRuntimeImport,
} from "@ericsanchezok/synergy-plugin/loader"
import path from "node:path"
import { realpath } from "node:fs/promises"
import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { isPathContained } from "../util/path-contain"

export async function readPluginUIAsset(
  plugin: { pluginDir: string; manifest: PluginManifest },
  relative: string,
  generation: string,
) {
  const { manifest } = plugin
  if (manifest.artifacts.generation !== generation) return
  const ui = manifest.artifacts.ui
  const skins = manifest.contributions.flatMap((item) =>
    item.kind === "ui.skin" ? [{ entry: item.path, sha256: item.sha256 }, ...item.assets] : [],
  )
  const hashed = [ui, ...(ui?.resources ?? []), ...skins].find((asset) => asset?.entry === relative)
  const declared =
    hashed ||
    manifest.contributions.some(
      (item) => (item.kind === "ui.theme" || item.kind === "ui.icon") && item.path === relative,
    )
  if (!declared) return
  const root = await realpath(plugin.pluginDir).catch(() => undefined)
  const file = await realpath(path.resolve(plugin.pluginDir, relative)).catch(() => undefined)
  if (!root || !file || !isPathContained(root, file)) return
  const data = await Bun.file(file)
    .bytes()
    .catch(() => undefined)
  if (!data) return
  if (hashed && new Bun.CryptoHasher("sha256").update(data).digest("hex") !== hashed.sha256) return
  if (relative === ui?.entry && ui.apiVersion === "5.0") {
    const source = new TextDecoder().decode(data)
    if (
      hasBundledSolidRuntime(source) ||
      hasUnsupportedSolidRuntimeImport(source) ||
      hasUnlinkedSolidRuntimeImport(source)
    )
      return
  }
  const types: Record<string, string> = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
  }
  return {
    data,
    mime: types[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    cacheControl: hashed ? "private, max-age=31536000, immutable" : "no-store",
  }
}
