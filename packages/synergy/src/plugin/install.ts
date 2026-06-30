import type { LoadedPlugin } from "./loader"
import { recordEvent } from "./audit.js"
import path from "path"
import fs from "fs/promises"
import z from "zod"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { BunProc } from "../util/bun"
import { PluginSpec } from "../util/plugin-spec"
import { Installation } from "../global/installation"
import * as Lockfile from "./lockfile"
import { resolveSpecPluginDir, state, specToPluginId } from "./loader"
import { reload } from "./lifecycle"
import { resolvePluginPolicyDecision } from "@ericsanchezok/synergy-util/plugin-policy"
import { resolvePluginSpec } from "./spec-resolver"
import { PluginInstallationTransaction } from "./installation-transaction"
import { ScopeContext } from "../scope/context"
import {
  type PluginApprovalRecord,
  computePermissionsHash,
  computeManifestHash,
  getApproval,
  verifyApproval,
} from "./consent/approval-store"
import type { PluginSource } from "./trust"
import { evaluatePolicy } from "./consent/policy"
import { type PluginApprovalPolicy, PLUGIN_APPROVAL_POLICY_DEFAULTS } from "../config/schema"
import * as Signature from "./signature"

const log = Log.create({ service: "plugin.install" })

// ---------------------------------------------------------------------------
// Semver helper for plugin engines.synergy checks
// ---------------------------------------------------------------------------

function parseVersion(input: string): [number, number, number] | null {
  const match = input
    .trim()
    .replace(/^v/, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersion(current: string, required: string): number | null {
  const a = parseVersion(current)
  const b = parseVersion(required)
  if (!a || !b) return null
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return 1
    if (a[i] < b[i]) return -1
  }
  return 0
}

function satisfiesSynergyComparator(current: string, comparator: string): boolean {
  const match = comparator.trim().match(/^(>=|>|<=|<|=)?\s*(v?\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)$/)
  if (!match) return false
  const op = match[1] ?? "="
  const required = match[2]
  const compared = compareVersion(current, required)
  if (compared === null) return false
  if (op === ">=") return compared >= 0
  if (op === ">") return compared > 0
  if (op === "<=") return compared <= 0
  if (op === "<") return compared < 0
  return compared === 0
}

export function satisfiesSynergyEngine(current: string, range: string): boolean {
  const comparators = range.trim().split(/\s+/).filter(Boolean)
  if (comparators.length === 0) return false
  return comparators.every((comparator) => satisfiesSynergyComparator(current, comparator))
}

// ---------------------------------------------------------------------------
// Add / remove
// ---------------------------------------------------------------------------

export async function resolveConfiguredPluginId(spec: string): Promise<string | null> {
  const mapped = specToPluginId.get(spec)
  if (mapped) return mapped

  try {
    const resolved = await resolvePluginSpec(spec, {
      cwd: process.cwd(),
      install: false,
      refresh: false,
    })
    return resolved.manifest.name
  } catch {
    return null
  }
}

export async function add(
  spec: string,
  opts: { autoReload?: boolean; skipConsent?: boolean; source?: PluginSource } = {},
): Promise<LoadedPlugin> {
  const parsedSpec = spec.startsWith("file://") ? { pkg: spec, version: "latest" } : PluginSpec.parse(spec)
  const { pkg, version } = parsedSpec
  let stagedDir: string | undefined

  // Audit: install requested
  void recordEvent({ pluginId: spec, type: "install_requested", details: { spec, version } })

  try {
    const resolved = await resolvePluginSpec(spec, {
      cwd: process.cwd(),
      install: !spec.startsWith("file://"),
      refresh: !spec.startsWith("file://"),
      stageLocalArchive: spec.startsWith("file://"),
    })
    stagedDir = resolved.stagingDir
    const pluginDir = resolved.pluginDir
    const manifestData: z.infer<typeof PluginManifest> = resolved.manifest
    const canonicalPluginId = manifestData.name
    log.info("plugin manifest loaded", { path: spec, manifest: manifestData })

    const synergyEngine = manifestData.engines?.synergy?.trim()
    if (synergyEngine && Installation.VERSION !== "local") {
      const currentVersion = Installation.VERSION
      if (!satisfiesSynergyEngine(currentVersion, synergyEngine)) {
        throw new Error(
          `Plugin ${spec} requires plugin.json engines.synergy "${synergyEngine}", but current Synergy version is ${currentVersion}`,
        )
      }
    }

    // -----------------------------------------------------------------------
    // Signature: read signature file (verify later when hashes are available)
    // -----------------------------------------------------------------------
    let sigMeta: Signature.SignatureMetadata | null = null
    if (!spec.startsWith("file://")) {
      const sigPath = path.join(pluginDir, "plugin.sig")
      sigMeta = Signature.readSignatureFile(sigPath)
      if (sigMeta) {
        log.info("plugin signature file found", { plugin: spec, signer: sigMeta.signer.slice(0, 16) + "..." })
      }
    }

    let permissionsHash: string | undefined
    let manifestHash: string | undefined
    let risk: "low" | "medium" | "high" = "low"
    let approvalRecord: PluginApprovalRecord | undefined
    const config = await Config.current()

    // Derive plugin source from spec (does not depend on manifest)
    const source: PluginSource = opts.source ?? resolved.source
    const devMode = Installation.CHANNEL === "local"

    const preApprovalPolicy = resolvePluginPolicyDecision({
      manifest: manifestData,
      source,
      userTrusted: false,
      verifiedIntegrity: sigMeta != null,
      devMode,
      policy: config.pluginRuntimePolicy,
    })
    const capabilities = preApprovalPolicy.capabilities
    risk = preApprovalPolicy.risk
    permissionsHash = computePermissionsHash(manifestData, capabilities)
    manifestHash = computeManifestHash(manifestData)

    // Verify signature against computed hashes
    if (sigMeta && permissionsHash && manifestHash) {
      const valid = await Signature.verifySignatureFromHashes(sigMeta, manifestHash, permissionsHash)
      if (valid) {
        log.info("plugin signature verified", { plugin: spec, signer: sigMeta.signer.slice(0, 16) + "..." })
      } else {
        log.warn("plugin signature verification failed", {
          plugin: spec,
          signer: sigMeta.signer.slice(0, 16) + "...",
        })
        sigMeta = null
      }
    }

    const trust = preApprovalPolicy.trust
    const policy: PluginApprovalPolicy = config.pluginApprovalPolicy ?? PLUGIN_APPROVAL_POLICY_DEFAULTS

    const runtimeModeForConsent = preApprovalPolicy.runtimeMode

    // Evaluate policy — may deny or auto-approve before consent
    const decision = evaluatePolicy({
      source,
      verified: sigMeta != null,
      risk,
      runtimeMode: runtimeModeForConsent,
      trustTier: trust.tier,
      signed: sigMeta != null,
      policy,
    })

    if (!decision.allowed) {
      throw new Error(`Plugin ${spec} installation denied by policy: ${decision.reason}`)
    }

    const autoApprove =
      decision.autoApproved ||
      opts.skipConsent === true ||
      (devMode && source === "local") ||
      trust.tier === "trusted-import"

    if (!autoApprove) {
      // Check for existing approval
      const existingApproval = await getApproval(canonicalPluginId)
      if (existingApproval && verifyApproval(existingApproval, manifestData, capabilities)) {
        log.info("plugin consent: existing approval matches", { plugin: spec })
      } else {
        throw new Error(
          `Plugin ${spec} requires approval before installation. ` +
            `Use \`synergy plugin approve ${spec}\` or the consent API first.`,
        )
      }
    }

    const approvedPolicy = resolvePluginPolicyDecision({
      manifest: manifestData,
      source,
      userTrusted: true,
      verifiedIntegrity: sigMeta != null || source === "official",
      devMode,
      policy: config.pluginRuntimePolicy,
    })

    const approvedBy: PluginApprovalRecord["approvedBy"] =
      opts.skipConsent === true
        ? "policy"
        : devMode && source === "local"
          ? "policy"
          : approvedPolicy.trust.tier === "trusted-import"
            ? "builtin"
            : "user"
    approvalRecord = {
      pluginId: canonicalPluginId,
      source,
      version: manifestData.version ?? version,
      manifestHash,
      permissionsHash,
      approvedAt: Date.now(),
      approvedBy,
      trustTier: approvedPolicy.trust.tier,
      approvedCapabilities: capabilities,
      approvedNetworkDomains: manifestData.permissions?.network?.connectDomains ?? [],
      approvedUISurfaces: [],
      risk,
    }
    log.info("plugin consent: approval recorded", { plugin: spec, risk, approvedBy })

    // Install declared dependencies
    if (manifestData.dependencies && Object.keys(manifestData.dependencies).length > 0) {
      for (const [depName, depVersion] of Object.entries(manifestData.dependencies)) {
        await BunProc.install(depName, depVersion)
        log.info("plugin dependency installed", { plugin: spec, dependency: depName, version: depVersion })
      }
    }

    const integrity = await Lockfile.computeIntegrity(resolved.entryPath)
    const runtimeMode = approvedPolicy.runtimeMode
    const lockEntry = {
      spec,
      source,
      version: manifestData.version ?? version,
      resolved: resolved.entryPath,
      ...(integrity ? { integrity } : {}),
      ...(permissionsHash ? { permissionsHash } : {}),
      ...(manifestHash ? { manifestHash } : {}),
      ...(sigMeta ? { signature: Signature.toLockfileSignature(sigMeta) } : {}),
      runtimeMode,
      approvalId: canonicalPluginId,
    } satisfies import("./lockfile-schema").PluginLockEntry

    const plugin = await PluginInstallationTransaction.upsert({
      spec,
      pluginId: canonicalPluginId,
      resolved,
      lockEntry,
      approval: approvalRecord,
      autoReload: opts.autoReload,
      reload,
      getLoaded: async () => state().then((x) => x.loaded),
      resolvePluginId: resolveConfiguredPluginId,
    })
    stagedDir = undefined
    specToPluginId.set(spec, plugin.id)

    // Audit: install approved
    void recordEvent({ pluginId: plugin.id, type: "install_approved", details: { spec, version } })

    // Auto-start runtime if the plugin needs process/worker isolation
    // This is a fire-and-forget — failures are logged but never block install.
    autoStartRuntime({
      pluginId: plugin.id,
      mode: runtimeMode,
      source,
      entryPath: plugin.entryPath ?? lockEntry.resolved,
      pluginDir: plugin.pluginDir,
    }).catch((err) => {
      log.warn("autoStartRuntime promise rejection (should not happen)", {
        pluginId: plugin.id,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    return plugin
  } catch (err) {
    // Audit: install blocked
    void recordEvent({
      pluginId: spec,
      type: "install_blocked",
      details: { spec, version, error: err instanceof Error ? err.message : String(err) },
    })
    throw err
  } finally {
    if (stagedDir) {
      await fs.rm(stagedDir, { recursive: true, force: true }).catch(() => {})
    }
  }
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

  for (const [key, value] of specToPluginId) {
    if (value === pluginId) {
      specToPluginId.delete(key)
    }
  }
  await PluginInstallationTransaction.remove({
    pluginId,
    pluginDir: plugin.pluginDir,
    autoReload: opts.autoReload,
    reload,
    resolveSpecPluginDir,
  })
}

// ---------------------------------------------------------------------------
// Auto-start runtime after install
// ---------------------------------------------------------------------------

export interface AutoStartRuntimeInput {
  pluginId: string
  mode: string
  source: import("../plugin/trust").PluginSource
  entryPath: string
  pluginDir: string
}

/**
 * Start a plugin runtime after install, unless the plugin runs in-process.
 * Returns true if the runtime was started, false if skipped or if start failed.
 * Failures are logged as warnings — they never block the install.
 */
export async function autoStartRuntime(input: AutoStartRuntimeInput): Promise<boolean> {
  if (input.mode === "in-process") return false

  try {
    const { startRuntime } = await import("../plugin-runtime/supervisor.js")
    const scope = ScopeContext.tryScope()
    await startRuntime(input.pluginId, {
      mode: input.mode as "worker" | "process",
      source: input.source,
      entryPath: input.entryPath,
      pluginDir: input.pluginDir,
      ...(scope ? { scope } : {}),
    })
    log.info("plugin runtime auto-started", { pluginId: input.pluginId, mode: input.mode })
    return true
  } catch (err) {
    log.warn("plugin runtime start failed (non-blocking)", {
      pluginId: input.pluginId,
      mode: input.mode,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}
