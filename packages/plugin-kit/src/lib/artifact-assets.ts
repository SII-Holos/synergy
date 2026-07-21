import fs from "fs"
import path from "path"
import { PluginArtifact } from "@ericsanchezok/synergy-plugin"
import { sha256File } from "./crypto.js"

function contained(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export function normalizeManifestPath(value: string) {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "")
  if (!normalized || path.isAbsolute(value) || normalized.split("/").includes("..")) {
    throw new Error(`Plugin artifact path must be relative: ${value}`)
  }
  return path.posix.normalize(normalized)
}

export function packageRelativePath(value: string) {
  const normalized = normalizeManifestPath(value)
  return normalized.startsWith("dist/") ? normalized.slice(5) : normalized
}

export function isManifestIconPath(value: string | undefined): value is string {
  if (!value || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false
  try {
    return normalizeManifestPath(value).toLowerCase().endsWith(".svg")
  } catch {
    return false
  }
}

export function resolveUnder(root: string, relativePath: string) {
  const resolved = path.resolve(root, normalizeManifestPath(relativePath))
  if (!contained(root, resolved)) throw new Error(`Plugin artifact path escapes ${root}: ${relativePath}`)
  return resolved
}

function walk(root: string, directory: string, output: Record<string, string>) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(root, file, output)
    else if (entry.isFile()) {
      const relative = path.relative(root, file).split(path.sep).join("/")
      if (relative !== PluginArtifact.integrityFile) output[relative] = sha256File(file)
    }
  }
}

export function hashPackagedFiles(distDir: string) {
  const files: Record<string, string> = {}
  walk(distDir, distDir, files)
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)))
}
