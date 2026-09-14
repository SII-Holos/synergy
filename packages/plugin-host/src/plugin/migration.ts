import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { writeLocalRegistry } from "./local-registry-store"
import * as Lockfile from "./lockfile"
import { writeApprovals } from "./consent/approval-store"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { computeManifestHash, computePermissionsHash } from "@ericsanchezok/synergy-plugin/integrity"
import type { Migration } from "@ericsanchezok/synergy-harness/migration"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { createApprovalRecord, type PluginApprovalRecord } from "./consent/approval-store"
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
      if (parsed.success)
        return {
          manifest: parsed.data,
          rawManifest: raw as PluginApprovalManifest,
          directory: path.dirname(candidate),
        }
    }
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
}

type PluginApprovalManifest = Parameters<typeof computeManifestHash>[0]

function pluginSource(value: unknown): PluginApprovalRecord["source"] {
  return ["local", "official", "npm", "git", "url", "builtin"].includes(String(value))
    ? (value as PluginApprovalRecord["source"])
    : "local"
}

async function migrateApprovalFile(
  data: string,
  manifests: Map<string, { manifest: PluginApprovalManifest; rawManifest: PluginApprovalManifest }>,
) {
  const [value] = await Storage.readMany([["plugin-approvals"]])
  const oldApprovals = Array.isArray(value) ? value : Object.values(record(value))
  const approvals: PluginApprovalRecord[] = []
  for (const value of oldApprovals) {
    const old = record(value)
    const pluginId = String(old.pluginId ?? old.id ?? "")
    const found = manifests.get(pluginId)
    if (!found || found.rawManifest.apiVersion !== "4.0") continue
    if (old.schemaVersion === 2 && old.grant && typeof old.grantHash === "string") {
      approvals.push(old as unknown as PluginApprovalRecord)
      continue
    }
    if (old.status !== "approved") continue
    const capabilities = Array.isArray(old.approvedCapabilities)
      ? old.approvedCapabilities.filter((item): item is string => typeof item === "string")
      : found.rawManifest.capabilities.map((item) => item.id)
    if (String(old.manifestHash ?? "") !== computeManifestHash(found.rawManifest)) continue
    if (String(old.capabilitiesHash ?? "") !== computePermissionsHash(found.rawManifest, capabilities)) continue
    approvals.push({
      ...createApprovalRecord({
        pluginId,
        source: pluginSource(old.source),
        manifest: found.manifest,
        capabilities,
        signer: typeof old.signer === "string" ? old.signer : undefined,
        approvedBy: old.approvedBy === "policy" || old.approvedBy === "builtin" ? old.approvedBy : "user",
      }),
      approvedAt: Number.isFinite(Number(old.approvedAt)) ? Number(old.approvedAt) : Date.now(),
    })
  }
  await Storage.write(["plugin-approvals"], approvals)
}

export async function migratePluginApprovalsV2(input: { root: string; data: string; cache: string }) {
  const rawLock = record((await Storage.readMany([["plugin-lock"]]))[0])
  const rawPlugins = record(rawLock.plugins)
  const manifests = new Map<string, { manifest: PluginApprovalManifest; rawManifest: PluginApprovalManifest }>()
  for (const [pluginId, value] of Object.entries(rawPlugins)) {
    const resolved = record(value).resolved
    if (typeof resolved !== "string") continue
    const found = await locateManifest(resolved)
    if (found) manifests.set(pluginId, { manifest: found.manifest, rawManifest: found.rawManifest })
  }
  await migrateApprovalFile(input.data, manifests)
  await fs.rm(path.join(input.cache, "plugin-market"), { recursive: true, force: true }).catch(() => undefined)
}

export async function migratePluginCatalog(input: {
  root: string
  data: string
  cache: string
  progress?: (current: number, total: number) => void
}) {
  const progress = input.progress ?? (() => undefined)
  const rawLock = record((await Storage.readMany([["plugin-lock"]]))[0])
  const rawPlugins = record(rawLock.plugins)
  const next: PluginLockfile = { version: 2, plugins: {} }
  const incompatible: IncompatiblePluginRecord[] = []
  const manifests = new Map<string, { manifest: PluginApprovalManifest; rawManifest: PluginApprovalManifest }>()
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
      manifests.set(manifest.id, { manifest, rawManifest: found.rawManifest })
    }
    progress(++current, Math.max(1, entries.length))
  }
  await Storage.write(["plugin-lock"], next)
  await IncompatiblePluginStore.write(incompatible)

  await migrateApprovalFile(input.data, manifests)
  await fs.rm(path.join(input.cache, "plugin"), { recursive: true, force: true }).catch(() => undefined)
  await fs.rm(path.join(input.cache, "plugin-market"), { recursive: true, force: true }).catch(() => undefined)
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
  {
    id: "20260801-plugin-api-4-stable-approvals",
    description: "Migrate Plugin API 4 approvals to stable access grants",
    version: "3.0.11",
    async up(progress) {
      progress(0, 1)
      await migratePluginApprovalsV2({ root: Global.Path.root, data: Global.Path.data, cache: Global.Path.cache })
      progress(1, 1)
    },
  },
  {
    id: "20260914-plugin-transactional-records",
    description: "Separate plugin installation, approval, and audit records in authoritative storage",
    async up(progress) {
      await Storage.transaction(async (tx) => {
        const [rawLock, approvals, audit, registry] = await tx.readMany([
          ["plugin-lock"],
          ["plugin-approvals"],
          ["plugin-audit"],
          ["registry", "plugins"],
        ])
        if (rawLock !== undefined) await Lockfile.write(rawLock as PluginLockfile)
        if (approvals !== undefined) {
          if (!Array.isArray(approvals)) throw new Error("Plugin approvals must be an array")
          await writeApprovals(approvals as PluginApprovalRecord[])
        }
        if (audit !== undefined) {
          if (!Array.isArray(audit)) throw new Error("Plugin audit history must be an array")
          for (const entry of audit) {
            const event = record(entry)
            if (typeof event.id !== "string" || typeof event.time !== "number")
              throw new Error("Plugin audit event has no stable identity")
            await tx.write(["plugin-audit", "events", `${String(event.time).padStart(16, "0")}_${event.id}`], event)
          }
        }
        if (registry !== undefined) {
          const entries = Array.isArray(registry) ? registry : record(registry).plugins
          if (!Array.isArray(entries) || entries.some((entry) => typeof record(entry).id !== "string"))
            throw new Error("Plugin registry entries have no stable identities")
          await writeLocalRegistry(entries as Array<{ id: string }>)
          await tx.remove(["registry", "plugins"])
        }
        await tx.remove(["plugin-lock"])
        await tx.remove(["plugin-approvals"])
        await tx.remove(["plugin-audit"])
      })
      progress(1, 1)
    },
  },
]

function pathToFileSpec(directory: string) {
  return pathToFileURL(directory).href
}

MigrationRegistry.register("plugin_catalog", migrations)
