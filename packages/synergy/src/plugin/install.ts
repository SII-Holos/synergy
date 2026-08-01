import path from "path"
import fs from "fs/promises"
import { Installation } from "../global/installation"
import { ScopeContext } from "../scope/context"
import { Log } from "../util/log"
import { PluginSpec } from "../util/plugin-spec"
import { computeManifestHash } from "@ericsanchezok/synergy-plugin/integrity"
import { createApprovalRecord, getApproval, type PluginApprovalRecord, verifyApproval } from "./consent/approval-store"
import { ensureRuntime, forgetPlugin, specToPluginId, state, type LoadedPlugin } from "./loader"
import { reload } from "./lifecycle"
import * as Lockfile from "./lockfile"
import { PluginInstallationTransaction } from "./installation-transaction"
import { pluginRuntimeManager } from "./runtime"
import { resolvePluginSpec } from "./spec-resolver"
import type { PluginSource } from "./trust"

const log = Log.create({ service: "plugin.install" })

export class PluginApprovalRequiredError extends Error {
  readonly code = "approval_required"

  constructor(
    readonly pluginId: string,
    readonly version: string,
    readonly manifest: LoadedPlugin["manifest"],
    readonly capabilities: string[],
  ) {
    super(`Plugin ${pluginId}@${version} requires approval before installation`)
    this.name = "PluginApprovalRequiredError"
  }
}

export async function resolveConfiguredPluginId(spec: string): Promise<string | null> {
  try {
    return (await resolvePluginSpec(spec, { cwd: ScopeContext.current.directory, install: false })).manifest.id
  } catch {
    return null
  }
}

async function prepareUpgrade(input: {
  oldPlugin?: LoadedPlugin
  resolved: Awaited<ReturnType<typeof resolvePluginSpec>>
}) {
  const oldPlugin = input.oldPlugin
  const manifest = input.resolved.manifest
  const upgrade = manifest.contributions.find((item) => item.kind === "lifecycle.upgrade")
  if (!oldPlugin || oldPlugin.manifest.version === manifest.version || !upgrade || !input.resolved.entryPath)
    return undefined
  const prepared = await pluginRuntimeManager.start({
    manifest,
    pluginDir: input.resolved.pluginDir,
    entryPath: input.resolved.entryPath,
    activate: false,
  })
  try {
    await pluginRuntimeManager.invoke({
      pluginId: manifest.id,
      handlerId: `lifecycle.upgrade:${upgrade.id}`,
      value: { fromVersion: oldPlugin.manifest.version, toVersion: manifest.version },
      context: {
        scopeId: ScopeContext.current.scope.id,
        directory: ScopeContext.current.directory,
        actor: { type: "lifecycle" },
      },
      pluginDir: input.resolved.pluginDir,
      manifest,
      runtimeKey: prepared.key,
    })
    return prepared
  } catch (error) {
    await pluginRuntimeManager.stopGeneration(prepared.key).catch(() => undefined)
    throw error
  }
}

export async function add(
  spec: string,
  options: {
    autoReload?: boolean
    skipConsent?: boolean
    source?: PluginSource
    signer?: string
    official?: boolean
    preApproved?: PluginApprovalRecord
  } = {},
): Promise<LoadedPlugin> {
  let stagingDir: string | undefined
  let preparedKey: string | undefined
  try {
    const resolved = await resolvePluginSpec(spec, {
      cwd: ScopeContext.current.directory,
      install: !spec.startsWith("file://"),
      refresh: !spec.startsWith("file://"),
      stageLocalArchive: spec.startsWith("file://"),
    })
    stagingDir = resolved.stagingDir
    const manifest = resolved.manifest
    const source = options.source ?? resolved.source
    const capabilities = manifest.capabilities.map((item) => item.id)
    const manifestHash = computeManifestHash(manifest)
    const existingApproval = await getApproval(manifest.id)
    const automaticallyApproved =
      options.skipConsent === true ||
      source === "builtin" ||
      (!existingApproval && source === "official" && options.official === true && Boolean(options.signer)) ||
      (Installation.CHANNEL === "local" && source === "local")

    let approval: PluginApprovalRecord
    if (options.preApproved) {
      if (
        options.preApproved.pluginId !== manifest.id ||
        options.preApproved.source !== source ||
        !verifyApproval(options.preApproved, manifest, capabilities, { source, signer: options.signer })
      ) {
        throw new PluginApprovalRequiredError(manifest.id, manifest.version, manifest, capabilities)
      }
      approval = createApprovalRecord({
        pluginId: manifest.id,
        source,
        manifest,
        capabilities,
        signer: options.signer ?? options.preApproved.signer,
        approvedBy: options.preApproved.approvedBy,
      })
    } else if (
      existingApproval &&
      verifyApproval(existingApproval, manifest, capabilities, { source, signer: options.signer })
    ) {
      approval = createApprovalRecord({
        pluginId: manifest.id,
        source,
        manifest,
        capabilities,
        signer: options.signer ?? existingApproval.signer,
        approvedBy: existingApproval.approvedBy,
      })
    } else if (automaticallyApproved) {
      approval = createApprovalRecord({
        pluginId: manifest.id,
        source,
        manifest,
        capabilities,
        signer: options.signer,
        approvedBy: options.skipConsent ? "policy" : source === "builtin" ? "builtin" : "policy",
      })
    } else {
      throw new PluginApprovalRequiredError(manifest.id, manifest.version, manifest, capabilities)
    }
    const oldPlugin = await state()
      .then((current) => current.loaded.find((plugin) => plugin.id === manifest.id))
      .catch(() => undefined)
    const prepared = await prepareUpgrade({ oldPlugin, resolved })
    preparedKey = prepared?.key

    const resolvedFile = resolved.entryPath ?? path.join(resolved.pluginDir, "plugin.json")
    const integrity = await Lockfile.computeIntegrity(resolvedFile)
    const lockEntry: import("./lockfile-schema").PluginLockEntry = {
      spec,
      source,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      generation: manifest.artifacts.generation,
      resolved: resolvedFile,
      ...(integrity ? { integrity } : {}),
      manifestHash,
      approvalId: manifest.id,
    }
    const plugin = await PluginInstallationTransaction.upsert({
      spec,
      pluginId: manifest.id,
      resolved,
      lockEntry,
      approval,
      autoReload: options.autoReload,
      reload,
      getLoaded: async () => state().then((current) => current.loaded),
      resolvePluginId: resolveConfiguredPluginId,
    })
    stagingDir = undefined
    for (const [registeredSpec, pluginId] of specToPluginId) {
      if (pluginId === plugin.id) specToPluginId.delete(registeredSpec)
    }
    specToPluginId.set(spec, plugin.id)
    if (prepared) await pluginRuntimeManager.activate(prepared.key)
    preparedKey = undefined
    return plugin
  } catch (error) {
    if (preparedKey) await pluginRuntimeManager.stopGeneration(preparedKey).catch(() => undefined)
    throw error
  } finally {
    if (stagingDir) await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
export async function updateReviewed(spec: string, approval: PluginApprovalRecord): Promise<LoadedPlugin> {
  return add(spec, { preApproved: approval })
}

export async function remove(pluginId: string, options: { force?: boolean } = {}): Promise<void> {
  const current = await state()
  const plugin = current.loaded.find((item) => item.id === pluginId)
  const disabled = current.disabled.find((item) => item.pluginId === pluginId)
  if (!plugin && !disabled) throw new Error(`Plugin not found: ${pluginId}`)

  await PluginInstallationTransaction.remove({
    pluginId,
    knownSpecs: [plugin?.spec, disabled?.spec].filter((spec): spec is string => Boolean(spec)),
    reload,
    resolvePluginId: resolveConfiguredPluginId,
    beforeCommit: async () => {
      if (plugin) await runPluginUninstallLifecycle(plugin, Boolean(options.force))
    },
  })
  await pluginRuntimeManager
    .stop(pluginId)
    .catch((error) => log.warn("plugin runtime stop failed during uninstall", { pluginId, error }))
  forgetPlugin(pluginId)
}

export async function runPluginUninstallLifecycle(
  plugin: LoadedPlugin,
  force: boolean,
  services: {
    ensureRuntime(plugin: LoadedPlugin): Promise<unknown>
    invoke(input: Parameters<typeof pluginRuntimeManager.invoke>[0]): Promise<unknown>
  } = { ensureRuntime, invoke: (input) => pluginRuntimeManager.invoke(input) },
) {
  if (force) return
  const uninstall = plugin.manifest.contributions.find((item) => item.kind === "lifecycle.uninstall")
  if (!uninstall) return
  await services.ensureRuntime(plugin)
  await services.invoke({
    pluginId: plugin.id,
    handlerId: `lifecycle.uninstall:${uninstall.id}`,
    value: {},
    context: {
      scopeId: ScopeContext.current.scope.id,
      directory: ScopeContext.current.directory,
      actor: { type: "lifecycle" },
    },
    pluginDir: plugin.pluginDir,
    manifest: plugin.manifest,
  })
}
