import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import { PluginInstallationRecovery } from "./installation-recovery"
import type { LoadedPlugin } from "./loader"
import type { PluginLockEntry } from "./lockfile-schema"
import type { PluginApprovalRecord } from "./consent/approval-store"
import fs from "fs/promises"
import path from "path"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import * as Lockfile from "./lockfile"
import { addEntry, removePluginEntries } from "./lockfile"
import { removeApproval, saveApproval } from "./consent/approval-store"
import type { ResolvedPluginSpec } from "./spec-resolver"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { recordEvent } from "./audit"
import { IncompatiblePluginStore } from "./incompatible-store"

const log = Log.create({ service: "plugin.install.transaction" })

export interface CanonicalizePluginSpecsInput {
  specs: string[]
  pluginId: string
  targetSpec?: string
  lockSpec?: string
  resolvePluginId?: (spec: string) => Promise<string | null> | string | null
}

export interface CanonicalizePluginSpecsResult {
  plugins: string[]
  removed: string[]
  changed: boolean
}

export interface SelectPluginRegistrationSpecsInput {
  pluginId: string
  specs: string[]
  knownSpecs: string[]
  resolvePluginId: (spec: string) => Promise<string | null> | string | null
}

export interface SelectPluginRegistrationSpecsResult {
  kept: string[]
  removed: string[]
}

export interface PluginInstallCommitInput {
  spec: string
  pluginId: string
  resolved: ResolvedPluginSpec
  lockEntry: PluginLockEntry
  approval?: PluginApprovalRecord
  autoReload?: boolean
  reload: () => Promise<void>
  getLoaded: () => Promise<LoadedPlugin[]>
  resolvePluginId?: (spec: string) => Promise<string | null> | string | null
}

export interface PluginRemoveCommitInput {
  pluginId: string
  knownSpecs: string[]
  reload: () => Promise<void>
  resolvePluginId: (spec: string) => Promise<string | null> | string | null
  beforeCommit?: () => Promise<void>
}

export interface PluginDoctorIssue {
  type:
    | "duplicate_config_spec"
    | "stale_lock_entry"
    | "lock_config_drift"
    | "orphan_archive_cache"
    | "invalid_archive_cache"
    | "missing_lock_resolved"
    | "invalid_runtime_state"
    | "unresolved_config_spec"
  pluginId?: string
  spec?: string
  path?: string
  message: string
  fixed?: boolean
}

export interface PluginDoctorResult {
  issues: PluginDoctorIssue[]
  changed: boolean
}

export async function withPluginInstallationLock<T>(fn: () => Promise<T>): Promise<T> {
  using lock = await Lock.write("plugin-installation")
  await PluginInstallationRecovery.recoverUnlocked()
  return fn()
}

export async function canonicalizePluginSpecs(
  input: CanonicalizePluginSpecsInput,
): Promise<CanonicalizePluginSpecsResult> {
  const resolvePluginId = input.resolvePluginId
  const groups = new Map<string, string[]>()
  const keepByIndex = new Set<number>()
  const removed: string[] = []

  for (let index = 0; index < input.specs.length; index++) {
    const spec = input.specs[index]!
    let pluginId: string | null = null
    if (spec === input.targetSpec) {
      pluginId = input.pluginId
    } else if (resolvePluginId) {
      pluginId = await resolvePluginId(spec)
    }
    if (!pluginId) {
      keepByIndex.add(index)
      continue
    }
    const group = groups.get(pluginId) ?? []
    group.push(spec)
    groups.set(pluginId, group)
  }

  if (input.targetSpec && !groups.get(input.pluginId)?.includes(input.targetSpec)) {
    const group = groups.get(input.pluginId) ?? []
    group.push(input.targetSpec)
    groups.set(input.pluginId, group)
  }

  const keepSpecByPlugin = new Map<string, string>()
  for (const [pluginId, specs] of groups) {
    const lockMatch = input.lockSpec && specs.includes(input.lockSpec) ? input.lockSpec : undefined
    const targetMatch = input.targetSpec && specs.includes(input.targetSpec) ? input.targetSpec : undefined
    keepSpecByPlugin.set(pluginId, lockMatch ?? targetMatch ?? specs[specs.length - 1]!)
  }

  const plugins: string[] = []
  for (let index = 0; index < input.specs.length; index++) {
    const spec = input.specs[index]!
    if (keepByIndex.has(index)) {
      plugins.push(spec)
      continue
    }
    const pluginId = spec === input.targetSpec ? input.pluginId : await input.resolvePluginId?.(spec)
    const keepSpec = pluginId ? keepSpecByPlugin.get(pluginId) : undefined
    if (keepSpec === spec && !plugins.includes(spec)) {
      plugins.push(spec)
    } else {
      removed.push(spec)
    }
  }

  if (
    input.targetSpec &&
    keepSpecByPlugin.get(input.pluginId) === input.targetSpec &&
    !plugins.includes(input.targetSpec)
  ) {
    plugins.push(input.targetSpec)
  }

  const changed =
    removed.length > 0 ||
    plugins.length !== input.specs.length ||
    plugins.some((spec, index) => spec !== input.specs[index])
  return { plugins, removed, changed }
}

export async function selectPluginRegistrationSpecs(
  input: SelectPluginRegistrationSpecsInput,
): Promise<SelectPluginRegistrationSpecsResult> {
  const known = new Set(input.knownSpecs)
  const kept: string[] = []
  const removed: string[] = []
  for (const spec of input.specs) {
    const matches = known.has(spec) || (await input.resolvePluginId(spec)) === input.pluginId
    if (matches) removed.push(spec)
    else kept.push(spec)
  }
  return { kept, removed }
}

function resolvedPathAfterPromotion(resolved: ResolvedPluginSpec): string {
  const resolvedFile = resolved.entryPath ?? path.join(resolved.pluginDir, "plugin.json")
  if (!resolved.stagingDir || !resolved.finalPluginDir) return resolvedFile
  return path.join(resolved.finalPluginDir, path.relative(resolved.stagingDir, resolvedFile))
}

function assertSingleLoadedPlugin(pluginId: string, loaded: LoadedPlugin[]) {
  const matches = loaded.filter((plugin) => plugin.id === pluginId)
  if (matches.length > 1) {
    throw new Error(`Plugin ${pluginId} loaded ${matches.length} times after install; config still contains duplicates`)
  }
  if (matches.length === 0) {
    throw new Error(`Plugin ${pluginId} was installed but failed to load`)
  }
  return matches[0]!
}

export namespace PluginInstallationTransaction {
  export async function upsert(input: PluginInstallCommitInput): Promise<LoadedPlugin> {
    return withPluginInstallationLock(async () => {
      const previousDomain = await Config.domainGet("plugins")
      const previousLockfile = await Lockfile.read()
      const previousIncompatible = await IncompatiblePluginStore.read()
      const currentPlugins = previousDomain.plugin ?? []
      const resolveConfiguredPluginId = async (spec: string): Promise<string | null> => {
        for (const [pluginId, entry] of Object.entries(previousLockfile.plugins)) {
          if (entry.spec === spec) return entry.approvalId ?? pluginId
        }
        return (await input.resolvePluginId?.(spec)) ?? null
      }
      const nextConfig = await canonicalizePluginSpecs({
        specs: currentPlugins,
        pluginId: input.pluginId,
        targetSpec: input.spec,
        lockSpec: input.lockEntry.spec,
        resolvePluginId: resolveConfiguredPluginId,
      })

      const nextDomain = { ...previousDomain, plugin: nextConfig.plugins }
      const recovery = await PluginInstallationRecovery.begin(input.pluginId, nextDomain, input.resolved)
      const lockEntry: PluginLockEntry = {
        ...input.lockEntry,
        resolved: resolvedPathAfterPromotion(input.resolved),
      }

      try {
        await recovery.promote()
        await Config.domainUpdate("plugins", nextDomain, { mode: "replace-domain" })
        await Storage.transaction(async () => {
          await Lockfile.write(addEntry(await Lockfile.read(), input.pluginId, lockEntry))
          if (input.approval) await saveApproval(input.approval)
          await IncompatiblePluginStore.write(
            IncompatiblePluginStore.withoutPlugin(previousIncompatible, input.pluginId, [
              input.spec,
              ...nextConfig.removed,
            ]),
          )
        })
        if (input.autoReload !== false) await input.reload()

        const loaded = await input.getLoaded()
        const plugin = assertSingleLoadedPlugin(input.pluginId, loaded)
        await recovery.finish()
        return plugin
      } catch (err) {
        const previousEntry = previousLockfile.plugins[input.pluginId]
        log.warn("plugin install transaction failed; rolling back", {
          pluginId: input.pluginId,
          error: err instanceof Error ? err.message : String(err),
        })
        await recovery.rollback()
        if (input.autoReload !== false) await input.reload().catch(() => {})
        if (previousEntry) {
          await recordEvent({
            pluginId: input.pluginId,
            type: "update_failed_rolled_back",
            details: {
              spec: input.spec,
              oldVersion: previousEntry.version,
              newVersion: input.lockEntry.version,
              error: err instanceof Error ? err.message : String(err),
              rolledBack: true,
            },
          })
        }
        throw err
      } finally {
        if (input.resolved.stagingDir) {
          await fs.rm(input.resolved.stagingDir, { recursive: true, force: true }).catch(() => {})
        }
      }
    })
  }

  export async function remove(input: PluginRemoveCommitInput): Promise<void> {
    await withPluginInstallationLock(async () => {
      const previousDomain = await Config.domainGet("plugins")
      const previousLockfile = await Lockfile.read()
      const previousIncompatible = await IncompatiblePluginStore.read()
      const currentPlugins = previousDomain.plugin ?? []
      const recordedIds = new Map<string, string>()
      for (const [pluginId, entry] of Object.entries(previousLockfile.plugins)) {
        recordedIds.set(entry.spec, entry.approvalId ?? pluginId)
      }
      for (const record of previousIncompatible) {
        if (record.spec) recordedIds.set(record.spec, record.pluginId)
      }
      const selected = await selectPluginRegistrationSpecs({
        pluginId: input.pluginId,
        specs: currentPlugins,
        knownSpecs: input.knownSpecs,
        resolvePluginId: async (spec) => recordedIds.get(spec) ?? (await input.resolvePluginId(spec)),
      })
      if (selected.removed.length === 0) {
        throw new Error(`Plugin registration not found: ${input.pluginId}`)
      }
      const nextDomain = { ...previousDomain, plugin: selected.kept } as any
      if (previousDomain.pluginConfig?.[input.pluginId]) {
        const { [input.pluginId]: _, ...rest } = previousDomain.pluginConfig ?? {}
        nextDomain.pluginConfig = rest
      }

      await input.beforeCommit?.()
      const recovery = await PluginInstallationRecovery.begin(input.pluginId, nextDomain)
      try {
        await Config.domainUpdate("plugins", nextDomain, { mode: "replace-domain" })
        await Storage.transaction(async () => {
          await Lockfile.write(removePluginEntries(await Lockfile.read(), input.pluginId, selected.removed))
          await removeApproval(input.pluginId)
          await IncompatiblePluginStore.write(
            IncompatiblePluginStore.withoutPlugin(previousIncompatible, input.pluginId, selected.removed),
          )
        })
        await input.reload()
        await recovery.finish()
      } catch (err) {
        await recovery.rollback()
        await input.reload().catch(() => {})
        throw err
      }
    })
  }

  export async function approve(input: {
    pluginId: string
    approval: PluginApprovalRecord | (() => Promise<PluginApprovalRecord>)
    reload: () => Promise<void>
    getLoaded: () => Promise<LoadedPlugin[]>
  }): Promise<LoadedPlugin> {
    return withPluginInstallationLock(async () => {
      const approval = typeof input.approval === "function" ? await input.approval() : input.approval
      const recovery = await PluginInstallationRecovery.begin(input.pluginId)
      try {
        await saveApproval(approval)
        await input.reload()
        const loaded = await input.getLoaded()
        const plugin = assertSingleLoadedPlugin(input.pluginId, loaded)
        await recovery.finish()
        return plugin
      } catch (err) {
        log.warn("plugin approval transaction failed; rolling back", {
          pluginId: input.pluginId,
          error: err instanceof Error ? err.message : String(err),
        })
        await recovery.rollback()
        await input.reload().catch(() => {})
        throw err
      }
    })
  }
}
