import fs from "fs"
import path from "path"
import type { PluginManifest } from "./manifest.js"

function resolvePackageEntry(pluginDir: string): string {
  const pkgPath = path.join(pluginDir, "package.json")
  if (!fs.existsSync(pkgPath)) return path.join(pluginDir, "index.ts")
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      exports?: string | { "."?: { bun?: string; import?: string } }
      main?: string
    }
    const exported =
      typeof pkg.exports === "string" ? pkg.exports : (pkg.exports?.["."]?.bun ?? pkg.exports?.["."]?.import)
    const entry = exported ?? pkg.main ?? "index.ts"
    return path.resolve(pluginDir, entry)
  } catch {
    return path.join(pluginDir, "index.ts")
  }
}

export function entryCandidatesFromPluginDir(pluginDir: string, manifest: PluginManifest): string[] {
  return [
    manifest.main ? path.resolve(pluginDir, manifest.main) : undefined,
    path.join(pluginDir, "dist", "runtime", "index.js"),
    path.join(pluginDir, "runtime", "index.js"),
    resolvePackageEntry(pluginDir),
    path.join(pluginDir, "src", "index.ts"),
    path.join(pluginDir, "index.ts"),
    path.join(pluginDir, "index.js"),
  ].filter(Boolean) as string[]
}

export function resolveEntryFromPluginDir(pluginDir: string, manifest: PluginManifest): string {
  const candidates = entryCandidatesFromPluginDir(pluginDir, manifest)
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}
