/**
 * Compute risk level from a set of capability strings.
 *
 * Rules:
 * - High: shell, filesystem writes, secrets, hooks.promptTransform
 * - Medium: filesystem reads, network with declared domains,
 *           session data, config writes, task delegation
 * - Low: all others
 * - No capabilities: "low"
 */
import type { PluginManifest } from "@ericsanchezok/synergy-plugin"

/**
 * Compute risk level from a set of capability strings, with optional
 * manifest context to resolve network domain declarations.
 *
 * Rules:
 * - High: shell, filesystem writes, secrets, hooks.promptTransform
 * - Medium: filesystem reads, network with declared domains,
 *           session data, config writes, task delegation
 * - Low: all others
 * - No capabilities: "low"
 */
export function computeRisk(capabilities: string[], manifest?: PluginManifest): "low" | "medium" | "high" {
  if (capabilities.length === 0) return "low"

  let risk: "low" | "medium" | "high" = "low"

  for (const cap of capabilities) {
    switch (cap) {
      // High-risk capabilities
      case "shell":
      case "filesystem:write":
      case "secrets":
      case "hooks.promptTransform":
        risk = "high"
        break

      // Medium-risk capabilities (only elevate if not already high)
      case "filesystem:read":
      case "session_data":
      case "config:write":
      case "task":
        if (risk !== "high") risk = "medium"
        break

      // network: with/without domains distinction
      // If manifest is provided, check declared domains to decide risk.
      // network with declared domains = medium, network without domains = high.
      case "network":
        if (risk === "high") break
        const domains = manifest?.permissions?.network?.connectDomains ?? []
        risk = domains.length > 0 ? "medium" : "high"
        break

      case "mcp:invoke":
      case "mcp:spawn":
      case "workspace_data":
      case "config:read":
      default:
        // Low-risk or unknown — don't change current risk
        break
    }
  }

  return risk
}
