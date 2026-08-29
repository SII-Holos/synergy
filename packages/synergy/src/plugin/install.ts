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
import { PluginInstallationTransaction, withPluginInstallationLock } from "./installation-transaction"
import { pluginRuntimeManager } from "./runtime"
import { peekRuntimeEndpointGeneration } from "../util/runtime-endpoint"
import { resolvePluginSpec } from "./spec-resolver"
import type { PluginSource } from "./trust"
import { resolvePluginRuntimeLimits } from "../plugin-runtime/runtime-limits"

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

export class PluginInstallLifecycleGenerationMismatchError extends Error {
  readonly code = "install_lifecycle_generation_mismatch"

  constructor(
    readonly pluginId: string,
    readonly lockfileGeneration: string,
    readonly loadedGeneration: string,
  ) {
    super(
      `Plugin ${pluginId} lockfile generation ${lockfileGeneration} does not match loaded generation ` +
        `${loadedGeneration}; reinstall or update the plugin to retry`,
    )
    this.name = "PluginInstallLifecycleGenerationMismatchError"
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
    const lockedEntry = lockfileBefore?.plugins[manifest.id]
    // A fresh install is a commit for a plugin that is not currently loaded and has no
    // lockfile entry. A lockfile entry means the plugin was installed at least once, so
    // its one-time install lifecycle already ran — legacy entries written before
    // lifecycleInstall tracking ran it synchronously. Disabled/approval-pending config
    // entries without a lockfile entry never completed an install and stay fresh.
    const freshInstall = oldPlugin === undefined && lockedEntry === undefined
    const prepared = await prepareUpgrade({ oldPlugin, resolved })
    preparedKey = prepared?.key

    const resolvedFile = resolved.entryPath ?? path.join(resolved.pluginDir, "plugin.json")
    const integrity = await Lockfile.computeIntegrity(resolvedFile)
    const hasInstallContribution = manifest.contributions.some((item) => item.kind === "lifecycle.install")
    // Fresh installs with a lifecycle.install contribution queue as pending (delivered
    // immediately inside a host process, otherwise at next host boot). Fresh installs
    // without the contribution never write the field, so `retry-install` reports "no
    // contribution" and boot catch-up never reprocesses the entry. Updates never re-run
    // lifecycle.install and keep the previously recorded state.
    const lifecycleInstall = !hasInstallContribution
      ? undefined
      : freshInstall
        ? "pending"
        : (lockfileBefore?.plugins[manifest.id]?.lifecycleInstall ?? "completed")
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
    if (freshInstall) {
      // Deliver install lifecycles (and the runtime.started catch-up) for every fresh
      // install; the helper no-ops for manifests without a lifecycle.install contribution.
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

export interface DeliverInstallLifecycleOptions {
  catchUpStarted?: boolean
  services?: InstallLifecycleServices
  /** Injectable runtime.started trigger (defaults to the real per-plugin trigger). */
  triggerStarted?: (input: { pluginId: string; generation: string; endpointGeneration: string }) => Promise<unknown>
}

/**
 * Install lifecycles currently being delivered. Guards against the config-watcher reload
 * re-selecting a pending entry while `add()` is still delivering the same plugin's hook:
 * a second delivery would interrupt the first runtime and repeat partial side effects.
 */
const installLifecyclesInFlight = new Set<string>()

export function isInstallLifecycleInFlight(pluginId: string): boolean {
  return installLifecyclesInFlight.has(pluginId)
}

async function persistInstallLifecycle(pluginId: string, status: "pending" | "completed" | "failed") {
  // All other lockfile writers serialize on the installation lock; persist under the same
  // lock so a read-modify-write cannot clobber a concurrent entry update.
  await withPluginInstallationLock(async () => {
    const lockfile = await Lockfile.read().catch(() => null)
    const entry = lockfile?.plugins[pluginId]
    if (!lockfile || !entry) return
    await Lockfile.write({
      ...lockfile,
      plugins: { ...lockfile.plugins, [pluginId]: { ...entry, lifecycleInstall: status } },
    })
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
  options: DeliverInstallLifecycleOptions = {},
): Promise<PluginInstallLifecycleStatus> {
  // Claim the in-flight slot for the whole delivery so a config-watcher reload cannot
  // re-select this pending entry and interrupt the running hook (see runPendingInstallLifecycles).
  installLifecyclesInFlight.add(plugin.id)
  try {
    return await deliverInstallLifecycleInner(plugin, options)
  } finally {
    installLifecyclesInFlight.delete(plugin.id)
  }
}

async function deliverInstallLifecycleInner(
  plugin: LoadedPlugin,
  options: DeliverInstallLifecycleOptions,
): Promise<PluginInstallLifecycleStatus> {
  const hasInstallContribution = plugin.manifest.contributions.some((item) => item.kind === "lifecycle.install")
  const endpointGeneration = peekRuntimeEndpointGeneration()
  if (!hasInstallContribution) {
    // No lifecycle.install contribution: nothing to deliver. Fresh installs leave the
    // lockfile field absent so retry-install reports "no contribution"; entries that
    // already carry a lifecycleInstall field (a stale "pending" written by earlier
    // versions) converge to completed so catch-up never reprocesses them.
    plugin.installLifecycle = { status: "skipped" }
    const lockfile = await Lockfile.read().catch(() => null)
    if (lockfile?.plugins[plugin.id]?.lifecycleInstall) {
      await persistInstallLifecycle(plugin.id, "completed").catch((error) =>
        log.warn("failed to persist completed install lifecycle", { pluginId: plugin.id, error }),
      )
    }
  } else if (!endpointGeneration) {
    plugin.installLifecycle = { status: "pending" }
  } else {
    const result = await runPluginInstallLifecycle(plugin, options.services)
    // runPluginInstallLifecycle only returns "skipped" when no lifecycle.install
    // contribution exists, which is handled above.
    plugin.installLifecycle =
      result.status === "failed" ? { status: "failed", error: result.error } : { status: "completed" }
    if (result.status === "completed") {
      await persistInstallLifecycle(plugin.id, "completed").catch((error) =>
        log.warn("failed to persist completed install lifecycle", { pluginId: plugin.id, error }),
      )
    } else if (result.status === "failed") {
      await persistInstallLifecycle(plugin.id, "failed").catch((error) =>
        log.warn("failed to persist failed install lifecycle", { pluginId: plugin.id, error }),
      )
    }
  }
  if (options.catchUpStarted !== false && endpointGeneration) {
    const trigger =
      options.triggerStarted ??
      ((input) =>
        triggerForPlugin(
          input.pluginId,
          input.generation,
          "runtime.started",
          {
            endpointGeneration: input.endpointGeneration,
          },
          {},
        ))
    await trigger({
      pluginId: plugin.id,
      generation: plugin.manifest.artifacts.generation,
      endpointGeneration,
    }).catch((error) => log.warn("plugin runtime.started catch-up failed", { pluginId: plugin.id, error }))
  }
  return plugin.installLifecycle
}

/**
 * Deliver pending install lifecycles. At host boot this runs after the catalog is loaded
 * and before the `runtime.started` broadcast, so the broadcast itself serves as the
 * catch-up (pass `catchUpStarted: false`, the default). On plugin runtime reload there is
 * no broadcast, so callers must pass `catchUpStarted: true` to deliver `runtime.started`
 * to each plugin whose pending lifecycle was delivered here.
 */
export async function runPendingInstallLifecycles(
  input: {
    plugins?: LoadedPlugin[]
    services?: InstallLifecycleServices
    catchUpStarted?: boolean
    triggerStarted?: DeliverInstallLifecycleOptions["triggerStarted"]
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
    // Skip entries whose delivery is already in flight (e.g. a config-watcher reload
    // racing an in-process add()): a second delivery would interrupt the running hook
    // and repeat partial side effects.
    if (isInstallLifecycleInFlight(pluginId)) continue
    const plugin = input.plugins?.find((item) => item.id === pluginId) ?? (await getPlugin(pluginId))
    if (!plugin) continue
    const locked = lockfile.plugins[pluginId]
    if (plugin.manifest.artifacts.generation !== locked.generation) {
      log.warn("skipping pending install lifecycle for stale generation", {
        pluginId,
        lockedGeneration: locked.generation,
        loadedGeneration: plugin.manifest.artifacts.generation,
      })
      continue
    }
    results.push(
      await deliverInstallLifecycle(plugin, {
        catchUpStarted: input.catchUpStarted ?? false,
        services: input.services,
        triggerStarted: input.triggerStarted,
      }),
    )
  }
  return results
}

/**
 * Re-queue a failed or pending install lifecycle. A completed install is never re-run.
 * When a host process is available the handler is delivered immediately; otherwise the
 * lockfile entry is set back to `pending` and the next host boot delivers it. Failed
 * installs are never retried automatically.
 */
export async function retryPluginInstallLifecycle(
  pluginId: string,
  services?: InstallLifecycleServices,
  loadedPlugin?: LoadedPlugin,
): Promise<PluginInstallLifecycleStatus> {
  const lockfile = await Lockfile.read().catch(() => null)
  const locked = lockfile?.plugins[pluginId]
  if (!locked) throw new Error(`Plugin not found: ${pluginId}`)
  if (!locked.lifecycleInstall) {
    throw new Error(`Plugin ${pluginId} does not declare a lifecycle.install contribution`)
  }
  if (locked.lifecycleInstall === "completed") return { status: "completed" }
  const plugin = loadedPlugin ?? (await getPlugin(pluginId))
  if (plugin && plugin.manifest.artifacts.generation !== locked.generation) {
    // Delivering against a mismatched generation would persist completed on the wrong
    // generation, and re-queueing is undeliverable (boot catch-up refuses stale
    // generations). Fail loudly so the user reinstalls/updates the plugin instead.
    throw new PluginInstallLifecycleGenerationMismatchError(
      pluginId,
      locked.generation,
      plugin.manifest.artifacts.generation,
    )
  }
  if (!plugin) {
    // Runtime not loaded (e.g. crashed or disabled). Resolve the installed manifest from
    // the lockfile spec (local cache read, no network) so a stale generation cannot be
    // silently re-queued into a pending state that boot catch-up will refuse forever.
    const resolved = await resolvePluginSpec(locked.spec, {
      cwd: ScopeContext.current.directory,
      install: false,
    }).catch(() => null)
    if (resolved && resolved.manifest.artifacts.generation !== locked.generation) {
      throw new PluginInstallLifecycleGenerationMismatchError(
        pluginId,
        locked.generation,
        resolved.manifest.artifacts.generation,
      )
    }
    if (!resolved) {
      log.warn("unable to resolve installed manifest for retry; re-queuing pending", { pluginId })
    }
    await persistInstallLifecycle(pluginId, "pending")
    return { status: "pending" }
  }
  if (!peekRuntimeEndpointGeneration()) {
    await persistInstallLifecycle(pluginId, "pending")
    plugin.installLifecycle = { status: "pending" }
    return plugin.installLifecycle
  }
  return deliverInstallLifecycle(plugin, { services })
}
