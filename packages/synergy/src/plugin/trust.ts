import path from "path"
import fs from "fs"
import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
import {
  defaultPluginTrustDecision,
  isTrustedPluginSource as sharedIsTrustedPluginSource,
  resolvePluginPolicyDecision,
} from "@ericsanchezok/synergy-util/plugin-policy"
import type { PluginPolicyDecision, PluginRuntimePolicyInput, PluginSource } from "@ericsanchezok/synergy-util/plugin-policy"
import { Global } from "../global"
import { Installation } from "../global/installation"
import { PluginSpec } from "../util/plugin-spec"
import * as Lockfile from "./lockfile"
import type { PluginLockEntry } from "./lockfile-schema"
import { getApproval } from "./consent/approval-store"
import type { PluginApprovalRecord } from "./consent/approval-store"

export {
  decideTrust,
  defaultPluginTrustDecision,
  isTrustedPluginSource,
  trustReason,
  trustSummary,
} from "@ericsanchezok/synergy-util/plugin-policy"
export type { PluginSource, PluginTrustDecision, TrustTier } from "@ericsanchezok/synergy-util/plugin-policy"

function sourceFromSpec(spec: string): PluginSource {
  if (spec.startsWith("file://")) return "local"
  if (/^https?:\/\//.test(spec)) return "url"
  if (PluginSpec.isNonRegistry(spec)) return "git"
  return "npm"
}

function sourceFromLockfile(pluginDir: string): PluginSource | undefined {
  try {
    const lockfilePath = path.join(Global.Path.root, "plugin.lock")
    const parsed = JSON.parse(fs.readFileSync(lockfilePath, "utf-8"))
    const entries = Object.values(parsed?.plugins ?? {}) as Array<{
      spec?: string
      source?: PluginSource
      resolved?: string
    }>
    const normalizedPluginDir = path.resolve(pluginDir)
    for (const entry of entries) {
      if (!entry.spec || !entry.resolved) continue
      const resolved = path.resolve(entry.resolved)
      const relative = path.relative(path.dirname(resolved), normalizedPluginDir)
      const reverse = path.relative(normalizedPluginDir, resolved)
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)))
        return entry.source ?? sourceFromSpec(entry.spec)
      if (reverse === "" || (!reverse.startsWith("..") && !path.isAbsolute(reverse)))
        return entry.source ?? sourceFromSpec(entry.spec)
    }
  } catch {}
}

/**
 * Derive the plugin source classification from its lockfile entry and directory path.
 * Lockfile specs win because cache paths alone cannot distinguish npm from git/url archives.
 */
export function derivePluginSource(pluginDir: string): PluginSource {
  const fromLockfile = sourceFromLockfile(pluginDir)
  if (fromLockfile) return fromLockfile

  const cacheRoot = Global.Path.cache
  const relative = path.relative(cacheRoot, pluginDir)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return "local"
  }
  if (relative.startsWith("plugin-archives")) return "local"
  return "npm"
}

export function approvedPluginTrustDecision(input: {
  source: PluginSource
  verifiedIntegrity?: boolean
  devMode?: boolean
}) {
  return defaultPluginTrustDecision({
    source: input.source,
    userTrusted: true,
    verifiedIntegrity: input.verifiedIntegrity ?? input.source === "official",
    devMode: input.devMode ?? false,
  })
}

export type PluginIntegrityStatus = "verified" | "unverified" | "failed"

/** Find the lockfile entry whose resolved plugin entry path is inside pluginDir. */
export async function findPluginLockEntry(pluginDir: string): Promise<PluginLockEntry | null> {
  try {
    const normalizedPluginDir = path.resolve(pluginDir)
    const lockfile = await Lockfile.read()
    for (const entry of Object.values(lockfile.plugins)) {
      const resolved = path.resolve(entry.resolved)
      const relative = path.relative(normalizedPluginDir, resolved)
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        return entry
      }
    }
  } catch {}
  return null
}

export async function resolvePluginIntegrity(pluginDir: string): Promise<PluginIntegrityStatus> {
  const entry = await findPluginLockEntry(pluginDir)
  if (!entry?.integrity) return "unverified"
  return (await Lockfile.checkIntegrity(entry)) ? "verified" : "failed"
}

export interface InstalledPluginPolicyInput {
  pluginId: string
  pluginDir: string
  manifest: PluginManifest
  source?: PluginSource
  approval?: PluginApprovalRecord | null
  userTrusted?: boolean
  verifiedIntegrity?: boolean
  devMode?: boolean
  policy?: PluginRuntimePolicyInput
  forceProcess?: boolean
  risk?: "low" | "medium" | "high"
}

export interface InstalledPluginPolicyDecision extends PluginPolicyDecision {
  approval?: PluginApprovalRecord
  integrity: PluginIntegrityStatus
}

export async function resolveInstalledPluginPolicy(
  input: InstalledPluginPolicyInput,
): Promise<InstalledPluginPolicyDecision> {
  const source = input.source ?? derivePluginSource(input.pluginDir)
  const [approval, integrity] = await Promise.all([
    input.approval === undefined ? getApproval(input.pluginId) : Promise.resolve(input.approval),
    input.verifiedIntegrity === undefined ? resolvePluginIntegrity(input.pluginDir) : Promise.resolve(undefined),
  ])
  const verifiedIntegrity = input.verifiedIntegrity ?? integrity === "verified"
  const userTrusted = input.userTrusted ?? (Boolean(approval) || sharedIsTrustedPluginSource(source))
  const policy = resolvePluginPolicyDecision({
    manifest: input.manifest,
    source,
    userTrusted,
    verifiedIntegrity,
    devMode: input.devMode ?? Installation.isLocal(),
    policy: input.policy,
    forceProcess: input.forceProcess,
    risk: input.risk,
  })
  return {
    ...policy,
    source,
    approval: approval ?? undefined,
    integrity:
      input.verifiedIntegrity === undefined
        ? (integrity ?? "unverified")
        : verifiedIntegrity
          ? "verified"
          : "unverified",
  }
}
