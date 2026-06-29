import z from "zod"
import path from "path"
import fs from "fs/promises"
import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { getPlugin, getLoadedPlugins } from "./loader"
import * as ManifestReader from "./manifest-reader"
import * as Capability from "./capability"
import { defaultPluginTrustDecision, derivePluginSource, type PluginTrustDecision, type PluginSource } from "./trust"
import { PluginToolId } from "./ids"
import { read as readLockfile, checkIntegrity } from "./lockfile"
import { Installation } from "../global/installation"
import { getRuntime } from "../plugin-runtime/supervisor"
import type { RuntimeLimits } from "../plugin-runtime/health"
import { computePermissionsHash, computeManifestHash } from "./consent/approval-store"
import { baseCapabilities } from "./capability"
import { getEvents } from "./audit.js"
import { PluginPaths } from "./paths"

// ---------------------------------------------------------------------------
// Comprehensive status — returned by GET /plugin/:id/status
// ---------------------------------------------------------------------------

export interface PluginStatus {
  id: string
  name?: string
  version?: string
  source: PluginSource
  trust: PluginTrustDecision
  loaded: boolean
  loadError?: string
  manifestValid: boolean
  integrity: "verified" | "unverified" | "failed"
  permissions: {
    base: string[]
    tools: Record<string, string[]>
    overallRisk: "low" | "medium" | "high"
    warnings: Capability.CapabilityWarning[]
  }
  routes: string[]
  tools: Array<{
    id: string
    fullId: string
    capabilities: string[]
    warnings: string[]
  }>
  ui: {
    contributions: number
    errors: string[]
  }
  stores: {
    config: boolean
    secrets: "none" | "plaintext" | "keychain"
    cacheBytes?: number
  }
  runtime?: {
    mode: string
    pid?: number
    state: string
    restarts: number
    lastHeartbeatAt?: number
    memoryMb?: number
    limits: RuntimeLimits
    lastError?: string
    runtimeDecision?: string
  }
  warnings: Array<{ type: string; message: string; toolId?: string }>
}

export const PluginStatusSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    version: z.string().optional(),
    source: z.enum(["local", "npm", "git", "url", "builtin", "official"]),
    trust: z.object({
      tier: z.enum(["declarative", "trusted-import", "sandbox"]),
      source: z.enum(["local", "npm", "git", "url", "builtin", "official"]),
      userTrusted: z.boolean(),
      verifiedIntegrity: z.boolean(),
      reason: z.string(),
    }),
    loaded: z.boolean(),
    loadError: z.string().optional(),
    manifestValid: z.boolean(),
    integrity: z.enum(["verified", "unverified", "failed"]),
    permissions: z.object({
      base: z.array(z.string()),
      tools: z.record(z.string(), z.array(z.string())),
      overallRisk: z.enum(["low", "medium", "high"]),
      warnings: z.array(
        z.object({
          type: z.string(),
          message: z.string(),
          toolId: z.string().optional(),
        }),
      ),
    }),
    routes: z.array(z.string()),
    tools: z.array(
      z.object({
        id: z.string(),
        fullId: z.string(),
        capabilities: z.array(z.string()),
        warnings: z.array(z.string()),
      }),
    ),
    ui: z.object({
      contributions: z.number(),
      errors: z.array(z.string()),
    }),
    stores: z.object({
      config: z.boolean(),
      secrets: z.enum(["none", "plaintext", "keychain"]),
      cacheBytes: z.number().optional(),
    }),
    runtime: z
      .object({
        mode: z.string(),
        pid: z.number().optional(),
        state: z.string(),
        restarts: z.number(),
        lastHeartbeatAt: z.number().optional(),
        memoryMb: z.number().optional(),
        limits: z.record(z.string(), z.any()),
        lastError: z.string().optional(),
        runtimeDecision: z.string().optional(),
      })
      .optional(),
    warnings: z.array(
      z.object({
        type: z.string(),
        message: z.string(),
        toolId: z.string().optional(),
      }),
    ),
  })
  .meta({ ref: "PluginStatus" })

/** Check whether we're running in dev mode (source checkout). */
function isDevMode(): boolean {
  return Installation.CHANNEL === "local"
}
/** Find the lockfile entry whose resolved path is under pluginDir. */
async function findLockfileEntry(pluginDir: string): Promise<import("./lockfile-schema").PluginLockEntry | null> {
  try {
    const lockfile = await readLockfile()
    for (const entry of Object.values(lockfile.plugins)) {
      const resolved = path.resolve(entry.resolved)
      const relative = path.relative(pluginDir, resolved)
      if (relative === "" || relative.startsWith("..") === false) {
        return entry
      }
    }
    return null
  } catch {
    return null
  }
}

/** Resolve integrity status from the lockfile by finding the entry whose resolved path is under pluginDir. */
async function resolveIntegrity(pluginDir: string): Promise<"verified" | "unverified" | "failed"> {
  const entry = await findLockfileEntry(pluginDir)
  if (!entry) return "unverified"
  if (!entry.integrity) return "unverified"
  const ok = await checkIntegrity(entry)
  return ok ? "verified" : "failed"
}
/** Derive secrets store type from presence of auth.json. */
async function resolveSecretsStore(pluginId: string): Promise<"none" | "plaintext" | "keychain"> {
  try {
    await fs.access(PluginPaths.authFile(pluginId))
    return "plaintext"
  } catch {
    return "none"
  }
}

/** Compute cache directory size in bytes. */
async function resolveCacheBytes(pluginId: string): Promise<number | undefined> {
  const cacheDir = PluginPaths.cacheDir(pluginId)
  try {
    let total = 0
    const entries = await fs.readdir(cacheDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          const stat = await fs.stat(path.join(cacheDir, entry.name))
          total += stat.size
        } catch {
          // ignore
        }
      }
    }
    return total > 0 ? total : undefined
  } catch {
    return undefined
  }
}

/** Count UI contributions from the manifest. */
function countUIContributions(manifest: PluginManifest): number {
  if (!manifest.contributes?.ui) return 0
  const ui = manifest.contributes.ui
  let count = 0
  if (ui.toolRenderers?.length) count += ui.toolRenderers.length
  if (ui.partRenderers?.length) count += ui.partRenderers.length
  if (ui.workspacePanels?.length) count += ui.workspacePanels.length
  if (ui.globalPanels?.length) count += ui.globalPanels.length
  if (ui.settings?.length) count += ui.settings.length
  if (ui.chatComponents?.length) count += ui.chatComponents.length
  if (ui.themes?.length) count += ui.themes.length
  if (ui.icons?.length) count += ui.icons.length
  if (ui.routes?.length) count += 1 // routes are a group
  if (ui.commands?.length) count += ui.commands.length
  return count
}

export async function getStatus(pluginId: string): Promise<PluginStatus | null> {
  const plugin = await getPlugin(pluginId)
  if (!plugin) return null

  const source = derivePluginSource(plugin.pluginDir)
  const warnings: PluginStatus["warnings"] = []
  const manifest = await ManifestReader.read(plugin.pluginDir)
  const manifestValid = true

  // ── Capabilities ──
  const manifestTools = manifest.contributes?.tools?.map((t) => t.name) ?? []
  const runtimeToolNames = plugin.hooks.tool ? Object.keys(plugin.hooks.tool) : []
  const runtimeFullIds = runtimeToolNames.map((t) => PluginToolId.format(pluginId, t))
  const allDeclared = [...new Set([...manifestTools, ...runtimeToolNames])]

  const capabilityResult = Capability.resolve({
    pluginId,
    manifest,
    declaredTools: allDeclared,
    runtimeToolIds: runtimeFullIds,
  })

  // ── Trust ──
  const integrity = await resolveIntegrity(plugin.pluginDir)
  const trust = defaultPluginTrustDecision({
    source,
    verifiedIntegrity: integrity === "verified",
    devMode: isDevMode(),
  })

  // ── Routes ──
  const routes = manifest.contributes?.ui?.routes?.map((r) => r.path) ?? []

  // ── Tools ──
  const tools = runtimeToolNames.map((id) => ({
    id,
    fullId: PluginToolId.format(pluginId, id),
    capabilities: capabilityResult.tools[id] ?? capabilityResult.base,
    warnings: capabilityResult.warnings.filter((w) => w.toolId === id || !w.toolId).map((w) => w.message),
  }))

  // ── UI ──
  const ui = {
    contributions: countUIContributions(manifest),
    errors: [] as string[],
  }

  // ── Stores ──
  const hasConfigStore = capabilityResult.base.includes("config:read") || capabilityResult.base.includes("config:write")
  const stores = {
    config: hasConfigStore,
    secrets: await resolveSecretsStore(pluginId),
    cacheBytes: await resolveCacheBytes(pluginId),
  }

  // ── Runtime ──
  const runtimeEntry = getRuntime(pluginId)
  const runtime = runtimeEntry
    ? {
        mode: runtimeEntry.mode,
        pid: runtimeEntry.pid,
        state: runtimeEntry.state,
        restarts: runtimeEntry.restarts,
        lastHeartbeatAt: runtimeEntry.lastHeartbeatAt,
        memoryMb: runtimeEntry.memoryMb,
        limits: runtimeEntry.limits,
        lastError: runtimeEntry.lastError,
        runtimeDecision: runtimeEntry.runtimeDecision,
      }
    : undefined

  // ── Hash consistency warnings ──
  const lockfileEntry = await findLockfileEntry(plugin.pluginDir)
  if (lockfileEntry) {
    const capabilities = baseCapabilities(manifest)
    const currentPermissionsHash = computePermissionsHash(manifest, capabilities)
    const currentManifestHash = computeManifestHash(manifest)
    if (lockfileEntry.permissionsHash && lockfileEntry.permissionsHash !== currentPermissionsHash) {
      warnings.push({
        type: "hash_mismatch",
        message: "Permissions have changed since install — re-approval may be required.",
      })
    }
    if (lockfileEntry.manifestHash && lockfileEntry.manifestHash !== currentManifestHash) {
      warnings.push({
        type: "hash_mismatch",
        message: "Manifest has changed since install.",
      })
    }
  }

  // ── Assemble warnings ──
  for (const w of capabilityResult.warnings) {
    warnings.push({ type: w.type, message: w.message, toolId: w.toolId })
  }
  if (integrity === "unverified") {
    warnings.push({
      type: "integrity",
      message: "Plugin integrity has not been verified against a lockfile hash.",
    })
  }

  // ── Rollback audit warnings ──
  try {
    const auditEvents = await getEvents(pluginId)
    for (const event of auditEvents) {
      if (event.type === "update_failed_rolled_back") {
        const details = event.details as {
          oldVersion?: string
          newVersion?: string
          error?: string
          rolledBack?: boolean
        }
        const msg =
          `Update from ${details.oldVersion ?? "?"} to ${details.newVersion ?? "?"} failed` +
          (details.rolledBack ? " and was rolled back" : "") +
          (details.error ? `: ${details.error}` : "")
        warnings.push({
          type: "update_failed_rolled_back",
          message: msg,
        })
      }
    }
  } catch {
    // Audit read failure is non-blocking for status
  }

  return {
    id: pluginId,
    name: plugin.name ?? manifest.name,
    version: manifest.version,
    source,
    trust,
    loaded: true,
    manifestValid,
    integrity,
    permissions: {
      base: capabilityResult.base,
      tools: capabilityResult.tools,
      overallRisk: capabilityResult.overallRisk,
      warnings: capabilityResult.warnings,
    },
    routes,
    tools,
    ui,
    stores,
    runtime,
    warnings,
  }
}

export async function getAllStatus(): Promise<PluginStatus[]> {
  const loaded = await getLoadedPlugins()
  const results: PluginStatus[] = []
  for (const p of loaded) {
    const s = await getStatus(p.id)
    if (s) results.push(s)
  }
  return results
}
