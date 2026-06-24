import type { PluginManifest } from "@ericsanchezok/synergy-plugin"
import type { PluginSource } from "./runtime-mode"

export interface CheckResult {
  type: "pass" | "warn" | "error"
  message: string
}

export function validateRuntimePolicy(input: {
  manifest: PluginManifest
  source: PluginSource
  trustTier: "declarative" | "trusted-import" | "sandbox"
  risk: "low" | "medium" | "high"
}): CheckResult[] {
  const results: CheckResult[] = []
  const { manifest, source, trustTier, risk } = input
  const effectiveMode = manifest.runtime?.mode ?? "in-process"
  const isThirdParty = source !== "local" && source !== "builtin"

  if (isThirdParty && effectiveMode === "in-process") {
    results.push({
      type: "error",
      message: `Third-party plugin (source=${source}) cannot run in-process. Use worker or process isolation.`,
    })
  }

  if (risk === "high" && effectiveMode === "in-process") {
    results.push({
      type: "error",
      message: "High-risk plugin cannot run in-process. Use worker or process isolation.",
    })
  }

  const requestedTier = manifest.trust?.requestedTier
  if (trustTier === "sandbox" && requestedTier !== "sandbox") {
    results.push({
      type: "warn",
      message:
        `Plugin has sandbox trust tier but effective runtime mode "${effectiveMode}" may not provide full sandbox isolation. ` +
        "Consider using process mode with explicit resource limits.",
    })
  }

  if (requestedTier !== undefined && requestedTier !== trustTier) {
    results.push({
      type: "warn",
      message:
        `Plugin requested trust tier "${requestedTier}" but was assigned "${trustTier}" ` +
        `(source=${source}). Runtime mode is "${effectiveMode}".`,
    })
  }

  if (effectiveMode === "worker") {
    const tools = manifest.permissions?.tools
    const hasShell = tools?.shell ?? false
    const hasFileWrite = tools?.filesystem === "write"
    const hasMcpSpawn = tools?.mcp === "spawn"
    const contributedTools = manifest.contributes?.tools ?? []
    const toolShell = contributedTools.some((tool) => tool.capabilities?.shell)
    const toolFileWrite = contributedTools.some((tool) => tool.capabilities?.filesystem === "write")
    if (hasShell || toolShell || hasFileWrite || toolFileWrite || hasMcpSpawn) {
      const unsupported: string[] = []
      if (hasShell || toolShell) unsupported.push("shell")
      if (hasFileWrite || toolFileWrite) unsupported.push("filesystem:write")
      if (hasMcpSpawn) unsupported.push("mcp:spawn")
      results.push({
        type: "warn",
        message: `Worker mode does not fully support: ${unsupported.join(", ")}. Consider process mode for these capabilities.`,
      })
    }
  }

  if (effectiveMode === "process" && !manifest.runtime?.resources) {
    results.push({
      type: "warn",
      message: "Process mode used without resource limits. Specify runtime.resources to prevent resource exhaustion.",
    })
  }

  return results
}
