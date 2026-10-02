export namespace PrimaryAgentIdentity {
  export const roles = ["general", "coding", "lightweight"] as const
  export type Role = (typeof roles)[number]

  export const names = {
    general: "synergy",
    coding: "synergy-max",
    lightweight: "synergy-flash",
  } as const

  export const labels: Record<Role, string> = {
    general: "Synergy",
    coding: "Synergy Max",
    lightweight: "Synergy Flash",
  }

  export function render(role: Role, prompt: string): string {
    return prompt.replaceAll("{AGENT_NAME}", names[role]).replaceAll("{AGENT_LABEL}", labels[role])
  }
}
