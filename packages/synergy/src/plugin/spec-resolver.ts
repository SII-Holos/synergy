import path from "path"
import fs from "fs"
import { fileURLToPath, pathToFileURL } from "url"
import { Global } from "../global"
import { BunProc } from "../util/bun"
import { PluginSpec } from "../util/plugin-spec"
import { PluginId } from "./ids"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import type { PluginDescriptor, PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"
import type { PluginSource } from "./trust"

export interface ResolvedPluginSpec {
  spec: string
  pkg: string
  version: string
  source: PluginSource
  entryPath: string
  pluginDir: string
  manifest: PluginManifestType | null
  cached?: boolean
  stagingDir?: string
  finalPluginDir?: string
}

export interface ResolvePluginSpecOptions {
  cwd?: string
  install?: boolean
  refresh?: boolean
  stageLocalArchive?: boolean
}

const ARCHIVE_RE = /\.(?:synergy-plugin\.)?t(?:ar\.)?gz$|\.tgz$/i

function pathFromFileSpec(spec: string): string {
  try {
    return fileURLToPath(spec)
  } catch {
    return spec.slice("file://".length)
  }
}

export function isArchivePath(filePath: string): boolean {
  return ARCHIVE_RE.test(filePath)
}

export function safeArchiveName(filePath: string): string {
  return path
    .basename(filePath)
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/^-+/, "")
}

export function archiveCacheDir(archivePath: string): string {
  return path.join(Global.Path.cache, "plugin-archives", safeArchiveName(archivePath).replace(/\.tgz$/i, ""))
}

/** Walk up from a file path to find the nearest directory containing package.json or plugin.json. */
export function findPackageRoot(entryPath: string): string {
  const stat = fs.existsSync(entryPath) ? fs.statSync(entryPath) : undefined
  let dir = stat?.isDirectory() ? entryPath : path.dirname(entryPath)
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "package.json")) || fs.existsSync(path.join(dir, "plugin.json"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return stat?.isDirectory() ? entryPath : path.dirname(entryPath)
}

export async function readPluginManifest(pluginDir: string): Promise<PluginManifestType | null> {
  const manifestPath = path.join(pluginDir, "plugin.json")
  const file = Bun.file(manifestPath)
  if (!(await file.exists().catch(() => false))) return null
  const parsed = PluginManifest.parse(JSON.parse(await file.text()))
  return parsed as PluginManifestType
}

function resolvePackageEntry(pluginDir: string): string {
  const pkgPath = path.join(pluginDir, "package.json")
  if (!fs.existsSync(pkgPath)) return path.join(pluginDir, "index.ts")
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
    const exported =
      typeof pkg.exports === "string" ? pkg.exports : (pkg.exports?.["."]?.bun ?? pkg.exports?.["."]?.import)
    const entry = exported ?? pkg.main ?? "index.ts"
    return path.resolve(pluginDir, entry)
  } catch {
    return path.join(pluginDir, "index.ts")
  }
}

export function resolveEntryFromPluginDir(pluginDir: string, manifest: PluginManifestType | null): string {
  const candidates = [
    manifest?.main ? path.resolve(pluginDir, manifest.main) : undefined,
    path.join(pluginDir, "dist", "runtime", "index.js"),
    path.join(pluginDir, "runtime", "index.js"),
    resolvePackageEntry(pluginDir),
    path.join(pluginDir, "src", "index.ts"),
    path.join(pluginDir, "index.ts"),
    path.join(pluginDir, "index.js"),
  ].filter(Boolean) as string[]

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}

async function extractArchive(archivePath: string, options: { stage?: boolean } = {}): Promise<string> {
  const targetDir = options.stage
    ? path.join(
        Global.Path.state,
        "plugin-install",
        "staging",
        `${safeArchiveName(archivePath).replace(/\.tgz$/i, "")}-${process.pid}-${Date.now()}`,
      )
    : archiveCacheDir(archivePath)
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.mkdirSync(targetDir, { recursive: true })
  const result = Bun.spawnSync(["tar", "-xzf", archivePath, "-C", targetDir], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr)
    throw new Error(`Failed to extract plugin archive ${archivePath}${stderr ? `: ${stderr}` : ""}`)
  }
  return targetDir
}

async function resolveLocalSpec(spec: string, options: ResolvePluginSpecOptions): Promise<ResolvedPluginSpec> {
  const rawPath = pathFromFileSpec(spec)
  const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(options.cwd ?? process.cwd(), rawPath)
  const archive = isArchivePath(absolute)
  const pluginDir = archive
    ? await extractArchive(absolute, { stage: options.stageLocalArchive })
    : findPackageRoot(absolute)
  const manifest = await readPluginManifest(pluginDir)
  const entryPath =
    fs.existsSync(absolute) && fs.statSync(absolute).isFile() && !archive
      ? absolute
      : resolveEntryFromPluginDir(pluginDir, manifest)
  const pkg = manifest?.name ?? path.basename(pluginDir)
  return {
    spec,
    pkg,
    version: manifest?.version ?? "0.0.0",
    source: "local",
    entryPath,
    pluginDir,
    manifest,
    ...(archive && options.stageLocalArchive
      ? { stagingDir: pluginDir, finalPluginDir: archiveCacheDir(absolute) }
      : {}),
  }
}

export async function resolvePluginSpec(
  spec: string,
  options: ResolvePluginSpecOptions = {},
): Promise<ResolvedPluginSpec> {
  if (spec.startsWith("file://")) {
    return resolveLocalSpec(spec, options)
  }

  const { pkg, version } = PluginSpec.parse(spec)
  const source: PluginSource = PluginSpec.isNonRegistry(spec) ? (spec.startsWith("http") ? "url" : "git") : "npm"

  if (!options.install) {
    const resolvedDir = path.join(
      Global.Path.cache,
      "node_modules",
      source === "npm" ? pkg : BunProc.resolvePkgName(pkg),
    )
    const pluginDir = findPackageRoot(resolvedDir)
    const manifest = await readPluginManifest(pluginDir).catch(() => null)
    return {
      spec,
      pkg,
      version,
      source,
      entryPath: resolveEntryFromPluginDir(pluginDir, manifest),
      pluginDir,
      manifest,
    }
  }

  if (options.refresh) {
    await BunProc.invalidateCache(pkg)
  }
  const installed = await BunProc.install(pkg, version)
  const pluginDir = findPackageRoot(installed.entryPath)
  const manifest = await readPluginManifest(pluginDir).catch(() => null)
  return {
    spec,
    pkg,
    version,
    source,
    entryPath: installed.entryPath,
    pluginDir,
    manifest,
    cached: installed.cached,
  }
}

export function importUrlForEntry(entryPath: string, reloadVersion?: number): string {
  const url = pathToFileURL(entryPath).href
  return reloadVersion == null ? url : `${url}?t=${reloadVersion}`
}

export function assertCanonicalPluginIdentity(input: {
  spec?: string
  manifest: PluginManifestType | null
  descriptor: PluginDescriptor
}) {
  const { manifest, descriptor, spec } = input
  if (!PluginId.isValid(descriptor.id)) {
    throw new Error(`Plugin descriptor id "${descriptor.id}" is invalid`)
  }
  if (manifest && manifest.name !== descriptor.id) {
    const suffix = spec ? ` for ${spec}` : ""
    throw new Error(
      `Plugin identity mismatch${suffix}: plugin.json name "${manifest.name}" must match PluginDescriptor.id "${descriptor.id}"`,
    )
  }
}
