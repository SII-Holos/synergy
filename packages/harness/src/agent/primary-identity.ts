export namespace PrimaryAgentIdentity {
  export const roles = ["general", "coding", "lightweight"] as const
  export type Role = (typeof roles)[number]

  export const names = {
    general: "atlas",
    coding: "forge",
    lightweight: "pico",
  } as const

  export const labels: Record<Role, string> = {
    general: "Atlas",
    coding: "Forge",
    lightweight: "Pico",
  }

  export function render(role: Role, prompt: string): string {
    return prompt.replaceAll("{AGENT_NAME}", names[role]).replaceAll("{AGENT_LABEL}", labels[role])
  }
}
