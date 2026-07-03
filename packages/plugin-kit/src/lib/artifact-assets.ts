import path from "path"
import fs from "fs"
import { PluginArtifact, type PluginManifest } from "@ericsanchezok/synergy-plugin"
import { sha256File } from "./crypto"

export interface PackagedAsset {
  label: string
  kind: "file" | "dir"
  sourceRelative: string
  packageRelative: string
}

function isExternalPath(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith("//")
}

function isPathContained(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(parent)
  const resolvedChild = path.resolve(child)
  const relative = path.relative(resolvedParent, resolvedChild)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export function isLocalManifestPath(value: string | undefined): value is string {
  return Boolean(value && !isExternalPath(value))
}

export function normalizeManifestPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "")
  if (!normalized || normalized === ".") throw new Error("Manifest path cannot be empty")
  if (path.posix.isAbsolute(normalized) || path.isAbsolute(value)) {
    throw new Error(`Manifest path must be relative: ${value}`)
  }
  const parts = normalized.split("/")
  if (parts.includes("..")) throw new Error(`Manifest path cannot escape the plugin directory: ${value}`)
  return path.posix.normalize(normalized)
}

export function packageRelativePath(value: string): string {
  const normalized = normalizeManifestPath(value)
  return normalized.startsWith("dist/") ? normalized.slice("dist/".length) : normalized
}

export function packageManifestPath(value: string): string {
  return `./${packageRelativePath(value)}`
}

export function isManifestIconPath(value: string | undefined): value is string {
  if (!isLocalManifestPath(value)) return false
  try {
    return normalizeManifestPath(value).toLowerCase().endsWith(".svg")
  } catch {
    return false
  }
}

function addAsset(assets: PackagedAsset[], input: { label: string; kind: "file" | "dir"; path?: string }) {
  if (!isLocalManifestPath(input.path)) return
  assets.push({
    label: input.label,
    kind: input.kind,
    sourceRelative: normalizeManifestPath(input.path),
    packageRelative: packageRelativePath(input.path),
  })
}

function addSandboxEntries(
  assets: PackagedAsset[],
  label: string,
  entries: Array<{ id?: string; sandboxEntry?: string }> | undefined,
) {
  for (const entry of entries ?? []) {
    addAsset(assets, {
      label: `${label}${entry.id ? ` "${entry.id}"` : ""} sandbox entry`,
      kind: "file",
      path: entry.sandboxEntry,
    })
  }
}

export function collectPackagedAssets(manifest: PluginManifest): PackagedAsset[] {
  const assets: PackagedAsset[] = []

  if (isManifestIconPath(manifest.icon)) {
    addAsset(assets, { label: "marketplace icon", kind: "file", path: manifest.icon })
  }

  for (const skill of manifest.contributes?.skills ?? []) {
    addAsset(assets, { label: `skill "${skill.name}" directory`, kind: "dir", path: skill.dir })
  }

  if (manifest.lifecycle?.install)
    addAsset(assets, { label: "install lifecycle script", kind: "file", path: manifest.lifecycle.install })
  if (manifest.lifecycle?.uninstall)
    addAsset(assets, { label: "uninstall lifecycle script", kind: "file", path: manifest.lifecycle.uninstall })
  if (manifest.lifecycle?.update)
    addAsset(assets, { label: "update lifecycle script", kind: "file", path: manifest.lifecycle.update })

  const ui = manifest.contributes?.ui
  if (ui?.entry) addAsset(assets, { label: "UI entry", kind: "file", path: ui.entry })
  for (const route of ui?.appRoutes ?? []) {
    addAsset(assets, { label: `app route "${route.id}" entry`, kind: "file", path: route.entry })
    addAsset(assets, { label: `app route "${route.id}" sandbox entry`, kind: "file", path: route.sandboxEntry })
  }
  addSandboxEntries(assets, "workbench panel", ui?.workbenchPanels)
  addSandboxEntries(assets, "app panel", ui?.appPanels)
  addSandboxEntries(assets, "settings", ui?.settings)
  for (const theme of ui?.themes ?? [])
    addAsset(assets, { label: `theme "${theme.id}"`, kind: "file", path: theme.path })
  for (const icon of ui?.icons ?? []) addAsset(assets, { label: `icon "${icon.name}"`, kind: "file", path: icon.path })

  const seen = new Set<string>()
  return assets.filter((asset) => {
    const key = `${asset.kind}:${asset.packageRelative}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function rewritePackagedManifestPaths(manifest: PluginManifest): PluginManifest {
  const next = structuredClone(manifest) as PluginManifest
  next.main = `./${PluginArtifact.runtimeEntry}`
  if (isManifestIconPath(next.icon)) next.icon = packageManifestPath(next.icon)
  const ui = next.contributes?.ui
  if (!ui) return next
  if (ui.entry) ui.entry = packageManifestPath(ui.entry)
  for (const route of ui.appRoutes ?? []) {
    if (route.entry) route.entry = packageManifestPath(route.entry)
    if (route.sandboxEntry) route.sandboxEntry = packageManifestPath(route.sandboxEntry)
  }
  for (const panel of ui.workbenchPanels ?? []) {
    if (panel.sandboxEntry) panel.sandboxEntry = packageManifestPath(panel.sandboxEntry)
  }
  for (const panel of ui.appPanels ?? []) {
    if (panel.sandboxEntry) panel.sandboxEntry = packageManifestPath(panel.sandboxEntry)
  }
  for (const settings of ui.settings ?? []) {
    if (settings.sandboxEntry) settings.sandboxEntry = packageManifestPath(settings.sandboxEntry)
  }
  return next
}

export function resolveUnder(root: string, relativePath: string): string {
  const normalized = normalizeManifestPath(relativePath)
  const resolved = path.resolve(root, normalized)
  if (!isPathContained(root, resolved)) {
    throw new Error(`Manifest path cannot escape ${root}: ${relativePath}`)
  }
  return resolved
}

export function copyPackagedAsset(pluginDir: string, distDir: string, asset: PackagedAsset): void {
  const src = resolveUnder(pluginDir, asset.sourceRelative)
  const dest = resolveUnder(distDir, asset.packageRelative)
  if (!fs.existsSync(src)) throw new Error(`${asset.label} not found at ${asset.sourceRelative}`)

  const stat = fs.statSync(src)
  if (asset.kind === "dir") {
    if (!stat.isDirectory()) throw new Error(`${asset.label} must be a directory: ${asset.sourceRelative}`)
    if (path.resolve(src) === path.resolve(dest)) return
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.cpSync(src, dest, { recursive: true })
    return
  }

  if (!stat.isFile()) throw new Error(`${asset.label} must be a file: ${asset.sourceRelative}`)
  if (path.resolve(src) === path.resolve(dest)) return
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
}

function walkFiles(root: string, dir: string, output: Record<string, string>) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filepath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(root, filepath, output)
      continue
    }
    if (!entry.isFile()) continue
    const relative = path.relative(root, filepath).split(path.sep).join("/")
    if (relative === PluginArtifact.integrityFile) continue
    output[relative] = sha256File(filepath)
  }
}

export function hashPackagedFiles(distDir: string): Record<string, string> {
  const files: Record<string, string> = {}
  walkFiles(distDir, distDir, files)
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
}

export function missingPackagedAssets(distDir: string, manifest: PluginManifest): PackagedAsset[] {
  return collectPackagedAssets(manifest).filter((asset) => !fs.existsSync(resolveUnder(distDir, asset.packageRelative)))
}
