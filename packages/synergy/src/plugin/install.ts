import type { LoadedPlugin } from "./loader"
import path from "path"
import z from "zod"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { BunProc } from "../util/bun"
import { PluginSpec } from "../util/plugin-spec"
import { Installation } from "../global/installation"
import * as Lockfile from "./lockfile"
import { findPackageRoot, resolveSpecPluginDir, state, specToPluginId } from "./loader"
import { reload } from "./lifecycle"

const log = Log.create({ service: "plugin.install" })

// ---------------------------------------------------------------------------
// Semver helper — lightweight comparison for minSynergyVersion checks
// ---------------------------------------------------------------------------

function satisfiesMinVersion(current: string, required: string): boolean {
  const [cm, cn, cp] = current.split(".").map(Number)
  const [rm, rn, rp] = required.split(".").map(Number)
  if (isNaN(cm) || isNaN(rm)) return false
  if (cm !== rm) return cm >= rm
  if (cn !== rn) return cn >= rn
  return cp >= rp
}

// ---------------------------------------------------------------------------
// Add / remove
// ---------------------------------------------------------------------------

export async function add(spec: string, opts: { autoReload?: boolean } = {}): Promise<LoadedPlugin> {
  const { pkg, version } = PluginSpec.parse(spec)

  // Explicit installs should refresh cached registry/git packages.
  await BunProc.invalidateCache(pkg)

  // Install the plugin package
  const result = await BunProc.install(pkg, version)

  // Read and validate plugin.json manifest if it exists
  const pluginDir = findPackageRoot(result.entryPath)
  const pluginJsonPath = path.join(pluginDir, "plugin.json")
  let manifestData: z.infer<typeof PluginManifest> | null = null
  try {
    const raw = await Bun.file(pluginJsonPath).text()
    const parsed = JSON.parse(raw)
    manifestData = PluginManifest.parse(parsed)
    log.info("plugin manifest loaded", { path: spec, manifest: manifestData })
  } catch (err) {
    log.warn("no valid plugin.json found, skipping manifest check", { path: spec, err: String(err) })
  }

  // Check minSynergyVersion compatibility
  if (manifestData?.minSynergyVersion && Installation.VERSION !== "local") {
    const currentVersion = Installation.VERSION
    if (!satisfiesMinVersion(currentVersion, manifestData.minSynergyVersion)) {
      throw new Error(
        `Plugin ${spec} requires Synergy >= ${manifestData.minSynergyVersion}, but current version is ${currentVersion}`,
      )
    }
  }

  // Install declared dependencies
  if (manifestData?.dependencies && Object.keys(manifestData.dependencies).length > 0) {
    for (const [depName, depVersion] of Object.entries(manifestData.dependencies)) {
      await BunProc.install(depName, depVersion)
      log.info("plugin dependency installed", { plugin: spec, dependency: depName, version: depVersion })
    }
  }

  // Update lockfile with installed plugin entry (including integrity hash)
  const lockfile = await Lockfile.read()
  const integrity = await Lockfile.computeIntegrity(result.entryPath)
  const updatedLockfile = Lockfile.addEntry(lockfile, pkg, {
    spec,
    version,
    resolved: result.entryPath,
    ...(integrity ? { integrity } : {}),
  })
  await Lockfile.write(updatedLockfile)

  // Add to config.plugin[] array
  const config = await Config.get()
  const currentPlugins = config.plugin ?? []
  if (!currentPlugins.includes(spec)) {
    await Config.updateGlobal({ plugin: [...currentPlugins, spec] } as any)
    await Config.reload("global")
  }

  // Reload plugins to load the new one
  if (opts.autoReload !== false) {
    await reload()
  }

  // Find the newly loaded plugin
  const { loaded } = await state()
  const plugin = loaded.find((p) => {
    // Match by checking if any plugin in the same pluginDir has a matching spec
    // For non-registry specs, match by the actual entry path
    return p.pluginDir === pluginDir
  })

  if (!plugin) {
    throw new Error(`Plugin was installed but failed to load: ${spec}`)
  }

  specToPluginId.set(spec, plugin.id)
  return plugin
}

export async function remove(pluginId: string, opts: { autoReload?: boolean } = {}): Promise<void> {
  const current = await state().catch(() => null)
  const plugin = current?.loaded.find((p) => p.id === pluginId)
  if (!plugin) {
    throw new Error(`Plugin not found: ${pluginId}`)
  }

  // Dispose the plugin
  if (plugin.hooks.dispose) {
    await plugin.hooks.dispose().catch((err) => {
      log.error("plugin dispose error during remove", { id: pluginId, err })
    })
  }

  // Remove from config.plugin[] array
  const config = await Config.get()
  const currentPlugins = config.plugin ?? []
  const kept = currentPlugins.filter((spec) => {
    const entry = specToPluginId.get(spec)
    if (entry != null) return entry !== pluginId
    return resolveSpecPluginDir(spec) !== plugin.pluginDir
  })

  if (kept.length < currentPlugins.length) {
    await Config.updateGlobal({ plugin: kept } as any)
  }

  // Remove pluginConfig.{pluginId}
  if (config.pluginConfig?.[pluginId]) {
    const { [pluginId]: _, ...rest } = config.pluginConfig ?? {}
    await Config.updateGlobal({ pluginConfig: rest } as any)
  }

  await Config.reload("global")

  // Clear the spec → pluginId mapping and remove from lockfile
  let lockfile = await Lockfile.read()
  for (const [key, value] of specToPluginId) {
    if (value === pluginId) {
      lockfile = Lockfile.removeEntry(lockfile, PluginSpec.parse(key).pkg)
      specToPluginId.delete(key)
    }
  }
  await Lockfile.write(lockfile)

  if (opts.autoReload !== false) {
    await reload()
  }
}
