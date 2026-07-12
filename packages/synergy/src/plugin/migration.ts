import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import type { Migration } from "../migration"
import { MigrationRegistry } from "../migration/registry"
import { Global } from "../global"
import { computeManifestHash, type PluginApprovalRecord } from "./consent/approval-store"
import type { PluginLockEntry, PluginLockfile } from "./lockfile-schema"
import { sourceFromSpec } from "./source"
import { IncompatiblePluginStore, type IncompatiblePluginRecord } from "./incompatible-store"

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await Bun.file(file).text())
  } catch {
    return undefined
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

async function locateManifest(resolved: string) {
  const stat = await fs.stat(resolved).catch(() => undefined)
  let directory = stat?.isDirectory() ? resolved : path.dirname(resolved)
  for (let depth = 0; depth < 4; depth++) {
    for (const candidate of [path.join(directory, "plugin.json"), path.join(directory, "dist", "plugin.json")]) {
      const raw = await readJson(candidate)
      const parsed = PluginManifest.safeParse(raw)
      if (parsed.success) return { manifest: parsed.data, directory: path.dirname(candidate) }
    }
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
}

export async function migratePluginCatalog(input: {
  root: string
  data: string
  cache: string
  progress?: (current: number, total: number) => void
}) {
  const progress = input.progress ?? (() => undefined)
  const lockPath = path.join(input.root, "plugin.lock")
  const rawLock = record(await readJson(lockPath))
  const rawPlugins = record(rawLock.plugins)
  const next: PluginLockfile = { version: 2, plugins: {} }
  const incompatible: IncompatiblePluginRecord[] = []
  const entries = Object.entries(rawPlugins)
  let current = 0
  for (const [pluginId, value] of entries) {
    const old = record(value)
    const resolved = typeof old.resolved === "string" ? old.resolved : ""
    const found = resolved ? await locateManifest(resolved) : undefined
    if (!found) {
      incompatible.push({
        pluginId,
        spec: typeof old.spec === "string" ? old.spec : undefined,
        reason: "reinstallRequired",
      })
    } else {
      const manifest = found.manifest
      const spec = typeof old.spec === "string" ? old.spec : pathToFileSpec(found.directory)
      const entry: PluginLockEntry = {
        spec,
        source: sourceFromSpec(spec),
        version: manifest.version,
        apiVersion: manifest.apiVersion,
        generation: manifest.artifacts.generation,
        resolved: found.directory,
        integrity: typeof old.integrity === "string" ? old.integrity : undefined,
        manifestHash: computeManifestHash(manifest),
        approvalId: manifest.id,
      }
      next.plugins[manifest.id] = entry
    }
    progress(++current, Math.max(1, entries.length))
  }
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  await Bun.write(lockPath, `${JSON.stringify(next, null, 2)}\n`)
  await IncompatiblePluginStore.write(incompatible, input.data)

  const oldApprovalsValue = await readJson(path.join(input.data, "plugin-approvals.json"))
  const oldApprovals = Array.isArray(oldApprovalsValue) ? oldApprovalsValue : Object.values(record(oldApprovalsValue))
  const approvals: PluginApprovalRecord[] = oldApprovals.map((value) => {
    const old = record(value)
    const pluginId = String(old.pluginId ?? old.id ?? "unknown")
    return {
      pluginId,
      source: ["local", "official", "npm", "git", "url", "builtin"].includes(String(old.source))
        ? (old.source as PluginApprovalRecord["source"])
        : "local",
      version: String(old.version ?? "0.0.0"),
      manifestHash: String(old.manifestHash ?? ""),
      capabilitiesHash: "",
      approvedAt: Number(old.approvedAt ?? Date.now()),
      approvedBy: "user",
      trustTier: "declarative",
      approvedCapabilities: [],
      risk: "low",
      status: "needsApproval",
    }
  })
  await Bun.write(path.join(input.data, "plugin-approvals.json"), `${JSON.stringify(approvals, null, 2)}\n`)
  await fs.rm(path.join(input.cache, "plugin"), { recursive: true, force: true }).catch(() => undefined)
}

const migrations: Migration[] = [
  {
    id: "20260712-plugin-api-3-catalog",
    description: "Migrate plugin catalog and require fresh capability approval",
    version: "3.0.0",
    async up(progress) {
      await migratePluginCatalog({ root: Global.Path.root, data: Global.Path.data, cache: Global.Path.cache, progress })
    },
  },
]

function pathToFileSpec(directory: string) {
  return pathToFileURL(directory).href
}

MigrationRegistry.register("plugin_catalog", migrations)
