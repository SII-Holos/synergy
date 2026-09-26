import {
  readPluginManifest as readManifest,
  assertPluginCompatibility as assertCompatibility,
} from "../installation/plugin-manifest"
import path from "path"
import fs from "fs"
import { fileURLToPath, pathToFileURL } from "url"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { BunProc } from "@ericsanchezok/synergy-harness/util/bun"
import { PluginSpec } from "@ericsanchezok/synergy-harness/util/plugin-spec"
import { normalizePluginArchiveEntry } from "@ericsanchezok/synergy-plugin"
import type { PluginManifestType } from "@ericsanchezok/synergy-plugin"
import type { PluginSource } from "./trust"
import { sourceFromSpec } from "./source"
import { Installation } from "@ericsanchezok/synergy-harness/global/installation"

export interface ResolvedPluginSpec {
  spec: string
  pkg: string
  version: string
  source: PluginSource
  entryPath?: string
  pluginDir: string
  manifest: PluginManifestType
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

export function assertPluginCompatibility(
  envelope: { apiVersion: string; compatibility: { synergy: string }; manifestVersion?: number },
  hostVersion = Installation.VERSION,
) {
  return assertCompatibility(envelope, hostVersion)
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

function validateArchiveEntries(archivePath: string) {
  const result = Bun.spawnSync(["tar", "-tzf", archivePath], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr)
    throw new Error(`Failed to inspect plugin archive ${archivePath}${stderr ? `: ${stderr}` : ""}`)
  }
  for (const line of new TextDecoder().decode(result.stdout).split("\n")) {
    try {
      normalizePluginArchiveEntry(line)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Plugin archive contains unsafe path: ${message}`)
    }
  }
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

export function readPluginManifest(pluginDir: string) {
  return readManifest(pluginDir, Installation.VERSION)
}

function runtimeEntry(pluginDir: string, manifest: PluginManifestType): string | undefined {
  return manifest.artifacts.runtime ? path.resolve(pluginDir, manifest.artifacts.runtime.entry) : undefined
}

async function validateExtractedArchiveDir(pluginDir: string): Promise<void> {
  const manifest = await readPluginManifest(pluginDir)
  const entryPath = runtimeEntry(pluginDir, manifest)
  if (entryPath && !fs.existsSync(entryPath)) {
    throw new Error(`Plugin entry not found at ${entryPath}. Synergy plugins must include a valid runtime entry.`)
  }
}

async function archiveCacheUsable(pluginDir: string): Promise<boolean> {
  if (!fs.existsSync(pluginDir)) return false
  try {
    await validateExtractedArchiveDir(pluginDir)
    return true
  } catch {
    return false
  }
}

async function extractArchive(archivePath: string, options: { stage?: boolean } = {}): Promise<string> {
  if (!options.stage) {
    const finalDir = archiveCacheDir(archivePath)
    if (await archiveCacheUsable(finalDir)) return finalDir
  }
  validateArchiveEntries(archivePath)
  const archiveName = safeArchiveName(archivePath).replace(/\.tgz$/i, "")
  const targetDir = path.join(
    Global.Path.state,
    "plugin-install",
    "staging",
    `${archiveName}-${process.pid}-${Date.now()}`,
  )
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.mkdirSync(targetDir, { recursive: true })
  const result = Bun.spawnSync(["tar", "-xzf", archivePath, "-C", targetDir], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr)
    fs.rmSync(targetDir, { recursive: true, force: true })
    throw new Error(`Failed to extract plugin archive ${archivePath}${stderr ? `: ${stderr}` : ""}`)
  }
  try {
    await validateExtractedArchiveDir(targetDir)
  } catch (err) {
    fs.rmSync(targetDir, { recursive: true, force: true })
    throw err
  }
  if (options.stage) return targetDir

  const finalDir = archiveCacheDir(archivePath)

  const backupDir = path.join(
    Global.Path.state,
    "plugin-install",
    "rollback",
    `${path.basename(finalDir)}-${process.pid}-${Date.now()}`,
  )
  fs.mkdirSync(path.dirname(finalDir), { recursive: true })
  fs.mkdirSync(path.dirname(backupDir), { recursive: true })
  const hadExisting = fs.existsSync(finalDir)
  if (hadExisting) {
    fs.rmSync(backupDir, { recursive: true, force: true })
    fs.renameSync(finalDir, backupDir)
  }
  try {
    fs.renameSync(targetDir, finalDir)
    if (hadExisting) fs.rmSync(backupDir, { recursive: true, force: true })
    return finalDir
  } catch (err) {
    fs.rmSync(finalDir, { recursive: true, force: true })
    if (hadExisting) {
      try {
        fs.renameSync(backupDir, finalDir)
      } catch {
        fs.rmSync(backupDir, { recursive: true, force: true })
      }
    }
    fs.rmSync(targetDir, { recursive: true, force: true })
    throw err
  }
}

async function resolveLocalSpec(spec: string, options: ResolvePluginSpecOptions): Promise<ResolvedPluginSpec> {
  const rawPath = pathFromFileSpec(spec)
  const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(options.cwd ?? Global.Path.config, rawPath)
  const archive = isArchivePath(absolute)
  let pluginDir = archive
    ? await extractArchive(absolute, { stage: options.stageLocalArchive })
    : findPackageRoot(absolute)
  const builtDir = path.join(pluginDir, "dist")
  if (!archive && fs.existsSync(path.join(builtDir, "plugin.json"))) pluginDir = builtDir
  const manifest = await readPluginManifest(pluginDir)
  const entryPath =
    fs.existsSync(absolute) && fs.statSync(absolute).isFile() && !archive ? absolute : runtimeEntry(pluginDir, manifest)
  const pkg = manifest.id
  return {
    spec,
    pkg,
    version: manifest.version,
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
  const source: PluginSource = sourceFromSpec(spec)

  if (!options.install) {
    const resolvedDir = path.join(
      Global.Path.cache,
      "node_modules",
      source === "npm" ? pkg : BunProc.resolvePkgName(pkg),
    )
    const pluginDir = findPackageRoot(resolvedDir)
    const manifest = await readPluginManifest(pluginDir)
    return {
      spec,
      pkg,
      version,
      source,
      entryPath: runtimeEntry(pluginDir, manifest),
      pluginDir,
      manifest,
    }
  }

  if (options.refresh) {
    await BunProc.invalidateCache(pkg)
  }
  const installed = await BunProc.install(pkg, version, { ignoreScripts: true })
  const pluginDir = findPackageRoot(installed.entryPath)
  const manifest = await readPluginManifest(pluginDir)
  return {
    spec,
    pkg,
    version,
    source,
    entryPath: runtimeEntry(pluginDir, manifest),
    pluginDir,
    manifest,
    cached: installed.cached,
  }
}

export function importUrlForEntry(entryPath: string, reloadVersion?: number): string {
  const url = pathToFileURL(entryPath).href
  return reloadVersion == null ? url : `${url}?t=${reloadVersion}`
}
