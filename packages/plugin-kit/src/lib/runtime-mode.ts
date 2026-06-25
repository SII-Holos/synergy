export type PluginSource = "local" | "official" | "npm" | "git" | "url" | "builtin"
export type RuntimeMode = "in-process" | "worker" | "process"

const TRUSTED_SOURCES: ReadonlySet<PluginSource> = new Set(["builtin", "official", "local"])

export function resolveRuntimeMode(input: {
  source: PluginSource
  manifestMode?: RuntimeMode
  userTrusted?: boolean
  risk?: "low" | "medium" | "high"
  forceProcess?: boolean
}): RuntimeMode {
  const { source, manifestMode, userTrusted = false, risk = "low", forceProcess = false } = input

  if (forceProcess) return "process"
  if (risk === "high") return "process"
  if (manifestMode === "process") return "process"
  if (manifestMode === "worker" && userTrusted) return "worker"
  if (manifestMode === "in-process") return TRUSTED_SOURCES.has(source) ? "in-process" : "process"
  return TRUSTED_SOURCES.has(source) ? "in-process" : "process"
}
