import type { LoadedPlugin } from "./loader"
import { recordEvent } from "./audit.js"
import path from "path"
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
import { baseCapabilities } from "./capability"
import { computeRisk } from "./consent/risk"
import { resolveRuntimeMode } from "../plugin-runtime/mode-resolver.js"
import { resolvePluginSpec } from "./spec-resolver"
import {
  type PluginApprovalRecord,
  computePermissionsHash,
  computeManifestHash,
  getApproval,
  verifyApproval,
  saveApproval,
} from "./consent/approval-store"
import { decideTrust, type PluginSource } from "./trust"
import { evaluatePolicy } from "./consent/policy"
import { type PluginApprovalPolicy, PLUGIN_APPROVAL_POLICY_DEFAULTS } from "../config/schema"
import * as Signature from "./signature"

const log = Log.create({ service: "plugin.install" })

// ---------------------------------------------------------------------------
// Semver helper — lightweight comparison for minSynergyVersion checks
// ---------------------------------------------------------------------------

function satisfiesMinVersion(current: string, required: string): boolean {
  const [currentMajor, currentMinor, currentPatch] = current.split(".").map(Number)
  const [requiredMajor, requiredMinor, requiredPatch] = required.split(".").map(Number)
  if (isNaN(currentMajor) || isNaN(requiredMajor)) return false
  if (currentMajor !== requiredMajor) return currentMajor >= requiredMajor
  if (currentMinor !== requiredMinor) return currentMinor >= requiredMinor
  return currentPatch >= requiredPatch
}

// ---------------------------------------------------------------------------
// Add / remove
// ---------------------------------------------------------------------------

async function resolveConfiguredPluginId(spec: string): Promise<string | null> {
  const mapped = specToPluginId.get(spec)
  if (mapped) return mapped

  try {
    const resolved = await resolvePluginSpec(spec, {
      cwd: process.cwd(),
      install: false,
      refresh: false,
    })
    return resolved.manifest?.name ?? resolved.pkg
  } catch {
    return null
  }
}

export async function nextConfiguredPluginSpecsForInstall(
  currentPlugins: string[],
  input: {
    spec: string
    pluginId: string
    resolvePluginId?: (spec: string) => Promise<string | null> | string | null
  },
): Promise<{ plugins: string[]; removed: string[]; changed: boolean }> {
  const resolvePluginId = input.resolvePluginId ?? resolveConfiguredPluginId
  const plugins: string[] = []
  const removed: string[] = []
  let hasTargetSpec = false

  for (const currentSpec of currentPlugins) {
    if (currentSpec === input.spec) {
      if (hasTargetSpec) {
        removed.push(currentSpec)
        continue
      }
      hasTargetSpec = true
      plugins.push(currentSpec)
      continue
    }

    const currentPluginId = await resolvePluginId(currentSpec)
    if (currentPluginId === input.pluginId) {
      removed.push(currentSpec)
      continue
    }

    plugins.push(currentSpec)
  }

  if (!hasTargetSpec) {
    plugins.push(input.spec)
  }

  const changed =
    removed.length > 0 ||
    plugins.length !== currentPlugins.length ||
    plugins.some((spec, index) => spec !== currentPlugins[index])
  return { plugins, removed, changed }
}

export async function add(
  spec: string,
  opts: { autoReload?: boolean; skipConsent?: boolean } = {},
): Promise<LoadedPlugin> {
  const parsedSpec = spec.startsWith("file://") ? { pkg: spec, version: "latest" } : PluginSpec.parse(spec)
  const { pkg, version } = parsedSpec

  // Audit: install requested
  void recordEvent({ pluginId: spec, type: "install_requested", details: { spec, version } })

  try {
    const resolved = await resolvePluginSpec(spec, {
      cwd: process.cwd(),
      install: !spec.startsWith("file://"),
      refresh: !spec.startsWith("file://"),
    })
    const pluginDir = resolved.pluginDir
    const manifestData: z.infer<typeof PluginManifest> | null = resolved.manifest
    const canonicalPluginId = manifestData?.name ?? resolved.pkg
    if (manifestData) {
      log.info("plugin manifest loaded", { path: spec, manifest: manifestData })
    } else {
      log.warn("no valid plugin.json found, skipping manifest check", { path: spec })
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

    // Derive plugin source from spec (does not depend on manifest)
    const source: PluginSource = resolved.source
    const devMode = Installation.CHANNEL === "local"

    if (manifestData) {
      const capabilities = baseCapabilities(manifestData)
      risk = computeRisk(capabilities, manifestData)
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

      const trust = decideTrust({ source, userTrusted: false, verifiedIntegrity: sigMeta != null, devMode })
      const config = await Config.current()
      const policy: PluginApprovalPolicy = config.pluginApprovalPolicy ?? PLUGIN_APPROVAL_POLICY_DEFAULTS

      // Compute runtime mode for policy evaluation
      const runtimeModeForConsent = resolveRuntimeMode({
        source,
        manifestMode: manifestData?.runtime?.mode,
        devMode,
        userTrusted: false,
        risk,
      })

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

      // Write approval record
      const approvedBy: PluginApprovalRecord["approvedBy"] =
        opts.skipConsent === true
          ? "policy"
          : devMode && source === "local"
            ? "policy"
            : trust.tier === "trusted-import"
              ? "builtin"
              : "user"
      await saveApproval({
        pluginId: canonicalPluginId,
        source,
        version: manifestData.version ?? version,
        manifestHash,
        permissionsHash,
        approvedAt: Date.now(),
        approvedBy,
        trustTier: trust.tier,
        approvedCapabilities: capabilities,
        approvedNetworkDomains: manifestData.permissions?.network?.connectDomains ?? [],
        approvedUISurfaces: [],
        risk,
      })
      log.info("plugin consent: approval recorded", { plugin: spec, risk, approvedBy })
    }

    // Install declared dependencies
    if (manifestData?.dependencies && Object.keys(manifestData.dependencies).length > 0) {
      for (const [depName, depVersion] of Object.entries(manifestData.dependencies)) {
        await BunProc.install(depName, depVersion)
        log.info("plugin dependency installed", { plugin: spec, dependency: depName, version: depVersion })
      }
    }

    // Update lockfile with installed plugin entry (including integrity + consent hashes)
    const lockfile = await Lockfile.read()
    const integrity = await Lockfile.computeIntegrity(resolved.entryPath)
    const runtimeMode = resolveRuntimeMode({
      source,
      manifestMode: manifestData?.runtime?.mode,
      devMode,
      userTrusted: false,
      risk,
    })
    const updatedLockfile = Lockfile.addEntry(lockfile, canonicalPluginId, {
      spec,
      version: manifestData?.version ?? version,
      resolved: resolved.entryPath,
      ...(integrity ? { integrity } : {}),
      ...(permissionsHash ? { permissionsHash } : {}),
      ...(manifestHash ? { manifestHash } : {}),
      ...(sigMeta ? { signature: Signature.toLockfileSignature(sigMeta) } : {}),
      runtimeMode,
      ...(manifestData ? { approvalId: canonicalPluginId } : {}),
    })
    await Lockfile.write(updatedLockfile)

    // Add to config.plugin[] array, replacing older specs that resolve to
    // the same plugin id so updates do not leave duplicate active installs.
    const config = await Config.current()
    const currentPlugins = config.plugin ?? []
    const nextConfig = await nextConfiguredPluginSpecsForInstall(currentPlugins, { spec, pluginId: canonicalPluginId })
    if (nextConfig.changed) {
      await Config.domainUpdate("plugins", { plugin: nextConfig.plugins } as any, { mode: "replace-domain" })
      for (const removedSpec of nextConfig.removed) {
        specToPluginId.delete(removedSpec)
      }
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

    // Audit: install approved
    void recordEvent({ pluginId: plugin.id, type: "install_approved", details: { spec, version } })

    // Auto-start runtime if the plugin needs process/worker isolation
    // This is a fire-and-forget — failures are logged but never block install.
    autoStartRuntime({
      pluginId: plugin.id,
      mode: runtimeMode,
      source,
      entryPath: resolved.entryPath,
      pluginDir,
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

  // Remove from config.plugin[] array
  const config = await Config.current()
  const currentPlugins = config.plugin ?? []
  const kept = currentPlugins.filter((spec) => {
    const entry = specToPluginId.get(spec)
    if (entry != null) return entry !== pluginId
    return resolveSpecPluginDir(spec) !== plugin.pluginDir
  })

  let configChanged = kept.length < currentPlugins.length
  let pluginConfig = config.pluginConfig

  if (config.pluginConfig?.[pluginId]) {
    const { [pluginId]: _, ...rest } = config.pluginConfig ?? {}
    pluginConfig = rest
    configChanged = true
  }

  if (configChanged) {
    await Config.domainUpdate("plugins", { plugin: kept, pluginConfig } as any, { mode: "replace-domain" })
    await Config.reload("global")
  }

  // Clear the spec → pluginId mapping and remove from lockfile
  let lockfile = await Lockfile.read()
  for (const [key, value] of specToPluginId) {
    if (value === pluginId) {
      lockfile = Lockfile.removeEntry(lockfile, pluginId)
      if (!key.startsWith("file://")) {
        lockfile = Lockfile.removeEntry(lockfile, PluginSpec.parse(key).pkg)
      }
      specToPluginId.delete(key)
    }
  }
  await Lockfile.write(lockfile)

  if (opts.autoReload !== false) {
    await reload()
  }
}

// ---------------------------------------------------------------------------
// Auto-start runtime after install
// ---------------------------------------------------------------------------

export interface AutoStartRuntimeInput {
  pluginId: string
  mode: string
  source?: import("../plugin/trust").PluginSource
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
    await startRuntime(input.pluginId, {
      mode: input.mode as "worker" | "process",
      source: input.source,
      entryPath: input.entryPath,
      pluginDir: input.pluginDir,
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
