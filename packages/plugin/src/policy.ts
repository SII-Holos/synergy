import type { PluginManifest } from "./manifest"
import { baseCapabilities, pluginRisk } from "./permissions"

export type PluginSource = "local" | "official" | "npm" | "git" | "url" | "builtin"
export type RuntimeMode = "in-process" | "worker" | "process"
export type TrustTier = "declarative" | "trusted-import" | "sandbox"
export type PolicyRisk = "low" | "medium" | "high"

export interface PluginTrustDecision {
  tier: TrustTier
  source: PluginSource
  userTrusted: boolean
  verifiedIntegrity: boolean
  reason: string
}

export interface RuntimeLimits {
  startupTimeoutMs: number
  toolInvocationTimeoutMs: number
  hookInvocationTimeoutMs: number
  bridgeRequestTimeoutMs: number
  taskRunTimeoutMs: number
  shutdownGraceMs: number
  maxConcurrentRequests: number
  maxLogBytesPerMinute: number
  memoryMb: number
  memoryPollIntervalMs: number
  heartbeatIntervalMs: number
  heartbeatMissesBeforeKill: number
}

export type RuntimeLimitOverrides = Partial<RuntimeLimits>

export interface PluginRuntimePolicyInput {
  thirdPartyDefaultMode?: "process" | "worker"
  highRiskRequiresProcess?: boolean
  allowThirdPartyInProcess?: boolean
  allowWorkerMode?: boolean
  allowLocalInProcess?: boolean
}

export interface PluginPolicyDecision {
  source: PluginSource
  capabilities: string[]
  risk: PolicyRisk
  trust: PluginTrustDecision
  runtimeMode: RuntimeMode
}

export const DEFAULT_PLUGIN_RUNTIME_POLICY: Required<PluginRuntimePolicyInput> = {
  thirdPartyDefaultMode: "process",
  highRiskRequiresProcess: true,
  allowThirdPartyInProcess: false,
  allowWorkerMode: true,
  allowLocalInProcess: true,
}

export const DEFAULT_PLUGIN_RUNTIME_LIMITS: RuntimeLimits = {
  startupTimeoutMs: 5_000,
  toolInvocationTimeoutMs: 120_000,
  hookInvocationTimeoutMs: 120_000,
  bridgeRequestTimeoutMs: 120_000,
  taskRunTimeoutMs: 120_000,
  shutdownGraceMs: 1_500,
  maxConcurrentRequests: 8,
  maxLogBytesPerMinute: 128_000,
  memoryMb: 256,
  memoryPollIntervalMs: 10_000,
  heartbeatIntervalMs: 5_000,
  heartbeatMissesBeforeKill: 3,
}

const TRUSTED_SOURCES: ReadonlySet<PluginSource> = new Set(["builtin", "official", "local"])
const THIRD_PARTY_SOURCES: ReadonlySet<PluginSource> = new Set(["npm", "git", "url"])

export function isTrustedPluginSource(source: PluginSource): boolean {
  return TRUSTED_SOURCES.has(source)
}

export interface ResolveRuntimeModeInput {
  source: PluginSource
  manifestMode?: RuntimeMode
  devMode?: boolean
  userTrusted?: boolean
  risk?: PolicyRisk
  forceProcess?: boolean
  policy?: PluginRuntimePolicyInput
}

export interface PolicyCheckResult {
  type: "pass" | "warn" | "error"
  message: string
}

function runtimePolicy(input?: PluginRuntimePolicyInput): Required<PluginRuntimePolicyInput> {
  return { ...DEFAULT_PLUGIN_RUNTIME_POLICY, ...(input ?? {}) }
}

export function resolveRuntimeMode(input: ResolveRuntimeModeInput): RuntimeMode {
  const policy = runtimePolicy(input.policy)
  const source = input.source
  const manifestMode = input.manifestMode
  const userTrusted = input.userTrusted ?? false
  const risk = input.risk ?? "low"

  if (input.forceProcess) return "process"
  if (policy.highRiskRequiresProcess && risk === "high") return "process"
  if (manifestMode === "process") return "process"

  if (manifestMode === "worker") {
    if (policy.allowWorkerMode && userTrusted) return "worker"
    return THIRD_PARTY_SOURCES.has(source) ? "process" : defaultTrustedMode(source, policy)
  }

  if (manifestMode === "in-process") {
    if (TRUSTED_SOURCES.has(source)) return defaultTrustedMode(source, policy)
    return policy.allowThirdPartyInProcess ? "in-process" : "process"
  }

  if (THIRD_PARTY_SOURCES.has(source)) {
    if (policy.thirdPartyDefaultMode === "worker" && policy.allowWorkerMode && userTrusted) return "worker"
    return "process"
  }

  return defaultTrustedMode(source, policy)
}

export function resolveRuntimeLimits(...overrides: Array<RuntimeLimitOverrides | undefined>): RuntimeLimits {
  const resolved = { ...DEFAULT_PLUGIN_RUNTIME_LIMITS }
  for (const override of overrides) {
    if (!override) continue
    for (const [key, value] of Object.entries(override) as Array<[keyof RuntimeLimits, unknown]>) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue
      resolved[key] = Math.round(value)
    }
  }
  return resolved
}

export function decideTrust(input: {
  source: PluginSource
  userTrusted: boolean
  verifiedIntegrity: boolean
  devMode: boolean
}): PluginTrustDecision {
  const { source, userTrusted, verifiedIntegrity, devMode } = input

  let tier: TrustTier
  let reason: string

  switch (source) {
    case "builtin":
      tier = "trusted-import"
      reason = "builtin plugin is always trusted"
      break
    case "official":
      tier = "trusted-import"
      reason = "official registry plugin is trusted"
      break
    case "local":
      tier = "trusted-import"
      reason = devMode ? "local plugin in dev mode" : "local plugin"
      break
    case "npm":
      if (userTrusted && verifiedIntegrity) {
        tier = "trusted-import"
        reason = "user-trusted npm plugin with verified integrity"
      } else {
        tier = "sandbox"
        reason = "npm plugin requires explicit user trust and verified integrity"
      }
      break
    case "git":
      if (userTrusted) {
        tier = "trusted-import"
        reason = "user-trusted git plugin"
      } else {
        tier = "sandbox"
        reason = "git plugin requires explicit user trust"
      }
      break
    case "url":
      tier = "sandbox"
      reason = "URL-sourced plugins always run in sandbox"
      break
  }

  return {
    tier,
    source,
    userTrusted,
    verifiedIntegrity,
    reason,
  }
}

export function defaultPluginTrustDecision(input: {
  source: PluginSource
  userTrusted?: boolean
  verifiedIntegrity?: boolean
  devMode?: boolean
}): PluginTrustDecision {
  return decideTrust({
    source: input.source,
    userTrusted: input.userTrusted ?? isTrustedPluginSource(input.source),
    verifiedIntegrity: input.verifiedIntegrity ?? false,
    devMode: input.devMode ?? false,
  })
}

export function resolvePluginPolicyDecision(input: {
  manifest: PluginManifest
  source: PluginSource
  userTrusted?: boolean
  verifiedIntegrity?: boolean
  devMode?: boolean
  policy?: PluginRuntimePolicyInput
  forceProcess?: boolean
  risk?: PolicyRisk
}): PluginPolicyDecision {
  const userTrusted = input.userTrusted ?? isTrustedPluginSource(input.source)
  const verifiedIntegrity = input.verifiedIntegrity ?? input.source === "official"
  const capabilities = baseCapabilities(input.manifest)
  const risk = input.risk ?? pluginRisk(input.manifest, { scope: "install" })
  const trust = decideTrust({
    source: input.source,
    userTrusted,
    verifiedIntegrity,
    devMode: input.devMode ?? false,
  })
  const runtimeMode = resolveRuntimeMode({
    source: input.source,
    manifestMode: input.manifest.runtime?.mode,
    devMode: input.devMode,
    userTrusted,
    risk,
    forceProcess: input.forceProcess,
    policy: input.policy,
  })
  return {
    source: input.source,
    capabilities,
    risk,
    trust,
    runtimeMode,
  }
}

export function trustReason(decision: PluginTrustDecision): string {
  const factors: string[] = []

  if (decision.userTrusted) factors.push("user-trusted")
  if (decision.verifiedIntegrity) factors.push("integrity verified")

  const factorText = factors.length > 0 ? ` (${factors.join(", ")})` : ""
  return `${decision.reason} → ${decision.tier}${factorText}`
}

export function trustSummary(decision: PluginTrustDecision): string {
  const metadata: string[] = []
  if (decision.userTrusted) metadata.push("trusted")
  if (decision.verifiedIntegrity) metadata.push("verified")

  const meta = metadata.length > 0 ? ` [${metadata.join(", ")}]` : ""
  return `${decision.source} → ${decision.tier}${meta}`
}

function defaultTrustedMode(source: PluginSource, policy: Required<PluginRuntimePolicyInput>): RuntimeMode {
  if (source === "local" && !policy.allowLocalInProcess) return "process"
  return "in-process"
}

export function validateRuntimePolicy(input: {
  manifest: PluginManifest
  source: PluginSource
  trustTier: TrustTier
  risk: PolicyRisk
  userTrusted?: boolean
  policy?: PluginRuntimePolicyInput
}): PolicyCheckResult[] {
  const results: PolicyCheckResult[] = []
  const requestedMode = input.manifest.runtime?.mode
  const effectiveMode = resolveRuntimeMode({
    source: input.source,
    manifestMode: requestedMode,
    userTrusted: input.userTrusted,
    risk: input.risk,
    policy: input.policy,
  })

  if (requestedMode && requestedMode !== effectiveMode) {
    results.push({
      type: "warn",
      message: `Plugin requested runtime mode "${requestedMode}" but Synergy will use "${effectiveMode}" for source=${input.source} and risk=${input.risk}.`,
    })
  }

  const requestedTier = input.manifest.trust?.requestedTier
  if (input.trustTier === "sandbox" && requestedTier !== "sandbox") {
    results.push({
      type: "warn",
      message: `Plugin has sandbox trust tier; effective runtime mode is "${effectiveMode}". Use process mode with explicit resource limits for strongest isolation.`,
    })
  }

  if (requestedTier !== undefined && requestedTier !== input.trustTier) {
    results.push({
      type: "warn",
      message: `Plugin requested trust tier "${requestedTier}" but was assigned "${input.trustTier}" (source=${input.source}). Runtime mode is "${effectiveMode}".`,
    })
  }

  if (effectiveMode === "worker") {
    const tools = input.manifest.permissions?.tools
    const hasShell = tools?.shell ?? false
    const hasFileWrite = tools?.filesystem === "write"
    const hasMcpSpawn = tools?.mcp === "spawn"
    const contributedTools = input.manifest.contributes?.tools ?? []
    const toolShell = contributedTools.some((tool) => tool.capabilities?.shell)
    const toolFileWrite = contributedTools.some((tool) => tool.capabilities?.filesystem === "write")
    if (hasShell || toolShell || hasFileWrite || toolFileWrite || hasMcpSpawn) {
      const unsupported: string[] = []
      if (hasShell || toolShell) unsupported.push("shell")
      if (hasFileWrite || toolFileWrite) unsupported.push("file_write")
      if (hasMcpSpawn) unsupported.push("mcp_spawn")
      results.push({
        type: "warn",
        message: `Worker mode does not fully support: ${unsupported.join(", ")}. Use process mode for these capabilities.`,
      })
    }
  }

  if (effectiveMode === "process" && !input.manifest.runtime?.resources) {
    results.push({
      type: "warn",
      message: "Process mode used without resource limits. Specify runtime.resources to prevent resource exhaustion.",
    })
  }

  return results
}
