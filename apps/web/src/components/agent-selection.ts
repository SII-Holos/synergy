import type { Agent } from "@ericsanchezok/synergy-sdk/client"

export function defaultPrimaryAgent(
  configured: string | undefined,
  agents: Pick<Agent, "name" | "mode" | "hidden">[],
): string | undefined {
  const visible = agents.filter((agent) => agent.mode !== "subagent" && !agent.hidden)
  return visible.find((agent) => agent.name === configured)?.name ?? visible[0]?.name
}
