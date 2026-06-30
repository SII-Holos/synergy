import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { Config } from "../config/config"
import { Global } from "../global"
import { archiveCacheDir, findPackageRoot, isArchivePath, resolvePluginSpec } from "./spec-resolver"
import * as Lockfile from "./lockfile"
import { withPluginInstallationLock, type PluginDoctorIssue, type PluginDoctorResult } from "./installation-transaction"

export type { PluginDoctorIssue, PluginDoctorResult }

function fileSpecPath(spec: string): string | null {
  if (!spec.startsWith("file://")) return null
  try {
    return fileURLToPath(spec)
  } catch {
    return spec.slice("file://".length)
  }
}

async function resolvePluginIdForSpec(spec: string, lockBySpec: Map<string, string>): Promise<string | null> {
  const locked = lockBySpec.get(spec)
  if (locked) return locked
  try {
    const resolved = await resolvePluginSpec(spec, { install: false, refresh: false })
    return resolved.manifest?.name ?? resolved.pkg
  } catch {
    return readLoosePluginIdForSpec(spec)
  }
}

async function readLoosePluginIdForSpec(spec: string): Promise<string | null> {
  const filepath = fileSpecPath(spec)
  if (!filepath || isArchivePath(filepath)) return null
  const root = findPackageRoot(filepath)
  try {
    const parsed = JSON.parse(await Bun.file(path.join(root, "plugin.json")).text())
    return typeof parsed?.name === "string" && parsed.name.length > 0 ? parsed.name : null
  } catch {
    return null
  }
}

function archiveDirForSpec(spec: string): string | null {
  const filepath = fileSpecPath(spec)
  if (!filepath || !isArchivePath(filepath)) return null
  return archiveCacheDir(filepath)
}

async function listArchiveCacheDirs(): Promise<string[]> {
  const root = path.join(Global.Path.cache, "plugin-archives")
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name))
}

export async function doctor(options: { fix?: boolean } = {}): Promise<PluginDoctorResult> {
  return withPluginInstallationLock(async () => {
    const issues: PluginDoctorIssue[] = []
    const domain = await Config.domainGet("plugins")
    const lockfile = await Lockfile.read()
    const lockBySpec = new Map<string, string>()
    for (const [pluginId, entry] of Object.entries(lockfile.plugins)) {
      lockBySpec.set(entry.spec, pluginId)
    }

    const specs = domain.plugin ?? []
    const pluginIdsBySpec = new Map<string, string>()
    const specsByPluginId = new Map<string, string[]>()
    for (const spec of specs) {
      const pluginId = await resolvePluginIdForSpec(spec, lockBySpec)
      if (!pluginId) {
        issues.push({
          type: "unresolved_config_spec",
          spec,
          message: `Configured plugin spec cannot be resolved: ${spec}`,
          fixed: false,
        })
        continue
      }
      pluginIdsBySpec.set(spec, pluginId)
      const group = specsByPluginId.get(pluginId) ?? []
      group.push(spec)
      specsByPluginId.set(pluginId, group)
    }

    const fixedSpecs: string[] = []
    const keptByPluginId = new Map<string, string>()
    for (const spec of specs) {
      const pluginId = pluginIdsBySpec.get(spec)
      if (!pluginId) {
        fixedSpecs.push(spec)
        continue
      }
      if (keptByPluginId.has(pluginId)) continue
      const group = specsByPluginId.get(pluginId) ?? [spec]
      const lockSpec = lockfile.plugins[pluginId]?.spec
      const keepSpec = lockSpec && group.includes(lockSpec) ? lockSpec : group[group.length - 1]!
      keptByPluginId.set(pluginId, keepSpec)
      fixedSpecs.push(keepSpec)
      if (group.length > 1) {
        for (const duplicate of group) {
          if (duplicate === keepSpec) continue
          issues.push({
            type: "duplicate_config_spec",
            pluginId,
            spec: duplicate,
            message: `Duplicate configured spec for ${pluginId}: ${duplicate}`,
            fixed: options.fix === true,
          })
        }
      }
    }

    const fixedSpecSet = new Set(fixedSpecs)
    let nextLockfile = lockfile
    for (const [pluginId, entry] of Object.entries(lockfile.plugins)) {
      if (!keptByPluginId.has(pluginId)) {
        issues.push({
          type: "stale_lock_entry",
          pluginId,
          spec: entry.spec,
          message: `Lockfile entry is not configured: ${pluginId}`,
          fixed: options.fix === true,
        })
        if (options.fix) nextLockfile = Lockfile.removeEntry(nextLockfile, pluginId)
        continue
      }
      if (!fixedSpecSet.has(entry.spec)) {
        const keptSpec = keptByPluginId.get(pluginId)
        issues.push({
          type: "lock_config_drift",
          pluginId,
          spec: entry.spec,
          message: `Lockfile spec for ${pluginId} does not match the kept configured spec${keptSpec ? `: ${keptSpec}` : ""}.`,
          fixed: options.fix === true,
        })
        if (options.fix) nextLockfile = Lockfile.removeEntry(nextLockfile, pluginId)
      }
    }

    const referencedArchiveDirs = new Set<string>()
    for (const spec of fixedSpecs) {
      const archiveDir = archiveDirForSpec(spec)
      if (archiveDir) referencedArchiveDirs.add(path.resolve(archiveDir))
    }
    for (const entry of Object.values(nextLockfile.plugins)) {
      referencedArchiveDirs.add(path.resolve(path.dirname(entry.resolved), ".."))
    }
    for (const archiveDir of await listArchiveCacheDirs()) {
      if (referencedArchiveDirs.has(path.resolve(archiveDir))) continue
      issues.push({
        type: "orphan_archive_cache",
        path: archiveDir,
        message: `Plugin archive cache is not referenced by config or lockfile: ${archiveDir}`,
        fixed: options.fix === true,
      })
      if (options.fix) await fs.rm(archiveDir, { recursive: true, force: true }).catch(() => {})
    }

    const configChanged = fixedSpecs.length !== specs.length || fixedSpecs.some((spec, index) => spec !== specs[index])
    const lockChanged = JSON.stringify(nextLockfile) !== JSON.stringify(lockfile)
    if (options.fix && configChanged) {
      await Config.domainUpdate("plugins", { ...domain, plugin: fixedSpecs } as any, { mode: "replace-domain" })
    }
    if (options.fix && lockChanged) {
      await Lockfile.write(nextLockfile)
    }

    if (options.fix) {
      for (const issue of issues) {
        if (issue.fixed === undefined) issue.fixed = true
      }
    }

    return { issues, changed: options.fix === true && (configChanged || lockChanged || issues.some((i) => i.fixed)) }
  })
}
