export type PluginSource = "local" | "official" | "npm" | "git" | "url" | "builtin"
export type RuntimeMode = "inProcess" | "process"
export type TrustTier = "declarative" | "trusted-import"
export type PolicyRisk = "low" | "medium" | "high"

export interface RuntimeLimits {
  startupTimeoutMs: number
  toolInvocationTimeoutMs: number
  hostServiceRequestTimeoutMs: number
  taskRunTimeoutMs: number
  shutdownGraceMs: number
  heartbeatIntervalMs: number
}

export type RuntimeLimitOverrides = Partial<RuntimeLimits>
export interface PluginRuntimePolicyInput {}

export const DEFAULT_PLUGIN_RUNTIME_POLICY = {} satisfies PluginRuntimePolicyInput
export const DEFAULT_PLUGIN_RUNTIME_LIMITS: RuntimeLimits = {
  startupTimeoutMs: 5_000,
  toolInvocationTimeoutMs: 120_000,
  hostServiceRequestTimeoutMs: 120_000,
  taskRunTimeoutMs: 120_000,
  shutdownGraceMs: 1_500,
  heartbeatIntervalMs: 5_000,
}

export interface PluginTrustDecision {
  tier: TrustTier
  source: PluginSource
  userTrusted: boolean
  verifiedIntegrity: boolean
  reason: string
}

export interface ResolveRuntimeModeInput {
  source: PluginSource
}
export interface PolicyCheckResult {
  type: "pass" | "warn" | "error"
  message: string
}

export function resolveRuntimeMode(input: ResolveRuntimeModeInput): RuntimeMode {
  return input.source === "builtin" ? "inProcess" : "process"
}

export function resolveRuntimeLimits(...overrides: Array<RuntimeLimitOverrides | undefined>): RuntimeLimits {
  const result = { ...DEFAULT_PLUGIN_RUNTIME_LIMITS }
  for (const override of overrides) {
    for (const [key, value] of Object.entries(override ?? {}) as Array<[keyof RuntimeLimits, unknown]>) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) result[key] = Math.round(value)
    }
  }
  return result
}

export function isTrustedPluginSource(source: PluginSource) {
  return source === "builtin" || source === "official" || source === "local"
}

export function decideTrust(input: {
  source: PluginSource
  userTrusted: boolean
  verifiedIntegrity: boolean
  devMode: boolean
}): PluginTrustDecision {
  return {
    source: input.source,
    userTrusted: input.userTrusted,
    verifiedIntegrity: input.verifiedIntegrity,
    tier: input.userTrusted || input.source === "builtin" ? "trusted-import" : "declarative",
    reason: input.userTrusted
      ? "plugin UI was explicitly trusted"
      : "plugin contributes declarations only until trusted",
  }
}

export function defaultPluginTrustDecision(input: {
  source: PluginSource
  userTrusted?: boolean
  verifiedIntegrity?: boolean
  devMode?: boolean
}) {
  return decideTrust({
    source: input.source,
    userTrusted: input.userTrusted ?? isTrustedPluginSource(input.source),
    verifiedIntegrity: input.verifiedIntegrity ?? false,
    devMode: input.devMode ?? false,
  })
}

interface FlatManifest {
  capabilities?: Array<{ id: string }>
}
export interface PluginPolicyDecision {
  source: PluginSource
  capabilities: string[]
  risk: PolicyRisk
  trust: PluginTrustDecision
  runtimeMode: RuntimeMode
}

export function resolvePluginPolicyDecision(input: {
  manifest: FlatManifest
  source: PluginSource
  userTrusted?: boolean
  verifiedIntegrity?: boolean
  devMode?: boolean
  risk?: PolicyRisk
}): PluginPolicyDecision {
  const capabilities = input.manifest.capabilities?.map((item) => item.id) ?? []
  const risk =
    input.risk ??
    (capabilities.some((item) => item.endsWith(".write") || item === "secrets" || item === "task.run")
      ? "high"
      : capabilities.length
        ? "medium"
        : "low")
  return {
    source: input.source,
    capabilities,
    risk,
    trust: defaultPluginTrustDecision(input),
    runtimeMode: resolveRuntimeMode({ source: input.source }),
  }
}

export function trustReason(decision: PluginTrustDecision) {
  return decision.reason
}
export function trustSummary(decision: PluginTrustDecision) {
  return `${decision.tier}: ${decision.reason}`
}
export function validateRuntimePolicy(): PolicyCheckResult[] {
  return [
    { type: "pass", message: "External plugins use the process runtime; built-ins may use the inProcess runtime." },
  ]
}
