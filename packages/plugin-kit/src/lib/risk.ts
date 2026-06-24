import type { PluginManifest } from "@ericsanchezok/synergy-plugin"

export function computeRisk(capabilities: string[], manifest?: PluginManifest): "low" | "medium" | "high" {
  if (capabilities.length === 0) return "low"

  let risk: "low" | "medium" | "high" = "low"

  for (const cap of capabilities) {
    switch (cap) {
      case "shell":
      case "filesystem:write":
      case "secrets":
      case "hooks.promptTransform":
        risk = "high"
        break
      case "filesystem:read":
      case "session_data":
      case "config:write":
        if (risk !== "high") risk = "medium"
        break
      case "network":
        if (risk !== "high") {
          const domains = manifest?.permissions?.network?.connectDomains ?? []
          risk = domains.length > 0 ? "medium" : "high"
        }
        break
    }
  }

  return risk
}
