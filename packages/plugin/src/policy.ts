import type { PluginManifest } from "./manifest"

export type PluginSource = "local" | "official" | "npm" | "git" | "url" | "builtin"
export type RuntimeMode = "in-process" | "worker" | "process"
export type TrustTier = "declarative" | "trusted-import" | "sandbox"
export type PolicyRisk = "low" | "medium" | "high"

export interface PluginRuntimePolicyInput {
  thirdPartyDefaultMode?: "process" | "worker"
  highRiskRequiresProcess?: boolean
  allowThirdPartyInProcess?: boolean
  allowWorkerMode?: boolean
  allowLocalInProcess?: boolean
}

export const DEFAULT_PLUGIN_RUNTIME_POLICY: Required<PluginRuntimePolicyInput> = {
  thirdPartyDefaultMode: "process",
  highRiskRequiresProcess: true,
  allowThirdPartyInProcess: false,
  allowWorkerMode: true,
  allowLocalInProcess: true,
}

const TRUSTED_SOURCES: ReadonlySet<PluginSource> = new Set(["builtin", "official", "local"])
const THIRD_PARTY_SOURCES: ReadonlySet<PluginSource> = new Set(["npm", "git", "url"])

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
      if (hasFileWrite || toolFileWrite) unsupported.push("filesystem:write")
      if (hasMcpSpawn) unsupported.push("mcp:spawn")
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
