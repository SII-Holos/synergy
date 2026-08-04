import path from "path"
import fs from "fs/promises"
import { Installation } from "../global/installation"
import { ScopeContext } from "../scope/context"
import { Log } from "../util/log"
import { PluginSpec } from "../util/plugin-spec"
import { computeManifestHash } from "@ericsanchezok/synergy-plugin/integrity"
import { createApprovalRecord, getApproval, type PluginApprovalRecord, verifyApproval } from "./consent/approval-store"
import {
  ensureRuntime,
  forgetPlugin,
  getPlugin,
  markContributionDegraded,
  specToPluginId,
  state,
  type LoadedPlugin,
} from "./loader"
import { reload, triggerForPlugin } from "./lifecycle"
import * as Lockfile from "./lockfile"
import { PluginInstallationTransaction } from "./installation-transaction"
import { pluginRuntimeManager } from "./runtime"
import { peekRuntimeEndpointGeneration } from "../server/runtime-endpoint"
import { resolvePluginSpec } from "./spec-resolver"
import type { PluginSource } from "./trust"
import { resolvePluginRuntimeLimits } from "./runtime-limits"

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
    limits: await resolvePluginRuntimeLimits(),
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
    const before = await state().catch(() => undefined)
    const oldPlugin = before?.loaded.find((plugin) => plugin.id === manifest.id)
    const lockfileBefore = await Lockfile.read().catch(() => null)
    // A fresh install is any successful commit for a plugin that is not currently loaded.
    // Disabled/approval-pending config entries must not suppress the install lifecycle:
    // the plugin has never completed an install, so lifecycle.install must still run once.
    const freshInstall = oldPlugin === undefined
    const prepared = await prepareUpgrade({ oldPlugin, resolved })
    preparedKey = prepared?.key

    const resolvedFile = resolved.entryPath ?? path.join(resolved.pluginDir, "plugin.json")
    const integrity = await Lockfile.computeIntegrity(resolvedFile)
    const hasInstallContribution = manifest.contributions.some((item) => item.kind === "lifecycle.install")
    // Fresh installs queue the lifecycle as pending (delivered immediately inside a host
    // process, otherwise at next host boot). Updates never re-run lifecycle.install and
    // keep the previously recorded state so a later `retry-install` still works.
    const lifecycleInstall = freshInstall
      ? "pending"
      : hasInstallContribution
        ? (lockfileBefore?.plugins[manifest.id]?.lifecycleInstall ?? "done")
        : undefined
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
      ...(lifecycleInstall ? { lifecycleInstall } : {}),
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
    if (freshInstall && hasInstallContribution) {
      await deliverInstallLifecycle(plugin)
    }
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

export async function runPluginInstallLifecycle(
  plugin: LoadedPlugin,
  services: {
    ensureRuntime(plugin: LoadedPlugin): Promise<unknown>
    invoke(input: Parameters<typeof pluginRuntimeManager.invoke>[0]): Promise<unknown>
    onFailure(
      plugin: LoadedPlugin,
      contribution: Extract<LoadedPlugin["manifest"]["contributions"][number], { kind: "lifecycle.install" }>,
      error: unknown,
    ): void
  } = {
    ensureRuntime,
    invoke: (input) => pluginRuntimeManager.invoke(input),
    onFailure(target, contribution, error) {
      markContributionDegraded(target, contribution, error)
      log.warn("plugin install lifecycle failed", { pluginId: target.id, contributionId: contribution.id, error })
    },
  },
): Promise<{ status: "skipped" | "completed" } | { status: "failed"; error: string }> {
  const install = plugin.manifest.contributions.find((item) => item.kind === "lifecycle.install")
  if (!install) return { status: "skipped" }
  try {
    await services.ensureRuntime(plugin)
    await services.invoke({
      pluginId: plugin.id,
      handlerId: `lifecycle.install:${install.id}`,
      value: {},
      context: {
        scopeId: ScopeContext.current.scope.id,
        directory: ScopeContext.current.directory,
        actor: { type: "lifecycle" },
      },
      pluginDir: plugin.pluginDir,
      manifest: plugin.manifest,
    })
    return { status: "completed" }
  } catch (error) {
    services.onFailure(plugin, install, error)
    return { status: "failed", error: error instanceof Error ? error.message : String(error) }
  }
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

export type PluginInstallLifecycleStatus = { status: "pending" | "completed" | "failed" | "skipped"; error?: string }

type InstallLifecycleServices = Parameters<typeof runPluginInstallLifecycle>[1]

async function persistInstallLifecycle(pluginId: string, status: "pending" | "done" | "failed") {
  const lockfile = await Lockfile.read().catch(() => null)
  const entry = lockfile?.plugins[pluginId]
  if (!lockfile || !entry) return
  await Lockfile.write({
    ...lockfile,
    plugins: { ...lockfile.plugins, [pluginId]: { ...entry, lifecycleInstall: status } },
  })
}

/**
 * Deliver the install lifecycle for a freshly installed plugin.
 *
 * Inside a host process (loopback endpoint configured) the handler runs immediately and the
 * resulting state is persisted to the lockfile. Outside a host process (e.g. `synergy plugin add`
 * in a standalone CLI) the lockfile entry stays `pending` and the next host boot delivers it via
 * `runPendingInstallLifecycles`. The plugin's `installLifecycle` field always reflects the outcome.
 */
export async function deliverInstallLifecycle(
  plugin: LoadedPlugin,
  options: { catchUpStarted?: boolean; services?: InstallLifecycleServices } = {},
): Promise<PluginInstallLifecycleStatus> {
  const endpointGeneration = peekRuntimeEndpointGeneration()
  if (!endpointGeneration) {
    plugin.installLifecycle = { status: "pending" }
    return plugin.installLifecycle
  }
  const result = await runPluginInstallLifecycle(plugin, options.services)
  plugin.installLifecycle =
    result.status === "failed"
      ? { status: "failed", error: result.error }
      : { status: result.status === "skipped" ? "skipped" : "completed" }
  if (result.status === "completed" || result.status === "skipped") {
    await persistInstallLifecycle(plugin.id, "done")
  } else {
    await persistInstallLifecycle(plugin.id, "failed")
  }
  if (options.catchUpStarted !== false) {
    await triggerForPlugin(
      plugin.id,
      plugin.manifest.artifacts.generation,
      "runtime.started",
      { endpointGeneration },
      {},
    ).catch((error) => log.warn("plugin runtime.started catch-up failed", { pluginId: plugin.id, error }))
  }
  return plugin.installLifecycle
}

/**
 * Deliver pending install lifecycles at host boot. Runs after the plugin catalog is loaded and
 * before the `runtime.started` broadcast, so the broadcast itself serves as the catch-up
 * notification for plugins delivered here.
 */
export async function runPendingInstallLifecycles(
  input: {
    plugins?: LoadedPlugin[]
    services?: InstallLifecycleServices
  } = {},
): Promise<PluginInstallLifecycleStatus[]> {
  const lockfile = await Lockfile.read().catch(() => null)
  if (!lockfile) return []
  const pendingIds = Object.entries(lockfile.plugins)
    .filter(([, entry]) => entry.lifecycleInstall === "pending")
    .map(([pluginId]) => pluginId)
  if (pendingIds.length === 0) return []
  const results: PluginInstallLifecycleStatus[] = []
  for (const pluginId of pendingIds) {
    const plugin = input.plugins?.find((item) => item.id === pluginId) ?? (await getPlugin(pluginId))
    if (!plugin) continue
    const locked = lockfile.plugins[pluginId]
    if (plugin.manifest.artifacts.generation !== locked.generation) continue
    results.push(await deliverInstallLifecycle(plugin, { catchUpStarted: false, services: input.services }))
  }
  return results
}

/**
 * Re-queue a failed install lifecycle. Inside a host process the handler is delivered
 * immediately; outside one (CLI) the lockfile is set back to `pending` and the next host boot
 * retries it. Failed installs are never retried automatically.
 */
export async function retryPluginInstallLifecycle(
  pluginId: string,
  services?: InstallLifecycleServices,
): Promise<PluginInstallLifecycleStatus | undefined> {
  const plugin = await getPlugin(pluginId)
  if (!plugin) throw new Error(`Plugin not found: ${pluginId}`)
  const install = plugin.manifest.contributions.find((item) => item.kind === "lifecycle.install")
  if (!install) throw new Error(`Plugin ${pluginId} does not declare a lifecycle.install contribution`)
  if (!peekRuntimeEndpointGeneration()) {
    await persistInstallLifecycle(pluginId, "pending")
    plugin.installLifecycle = { status: "pending" }
    return plugin.installLifecycle
  }
  return deliverInstallLifecycle(plugin, { services })
}
