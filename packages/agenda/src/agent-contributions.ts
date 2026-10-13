import { AgentPermissionContributions } from "@ericsanchezok/synergy-harness/agent/permission-contributions"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"
export function registerAgentContributions() {
  AgentPermissionContributions.register("agenda", {
    base: (agent, identity) =>
      (identity.owner === "harness" && agent.mode === "subagent") ||
      (identity.source === "builtin" &&
        ((identity.owner === "blueprint" && identity.registrationKey === "supervisor") ||
          (identity.owner === "light-loop" && identity.registrationKey === "lightloop-reviewer")))
        ? PermissionNext.fromConfig({ agenda_list: "allow", agenda_logs: "allow" })
        : [],
  })
  AgentPromptContributions.register("agenda", [
    {
      requiredTools: ["agenda_schedule", "agenda_watch"],
      render: () =>
        "Agenda schedules one-time wake-ups with agenda_watch and recurring work with agenda_schedule. The default delivery auto returns results to the originating conversation. Override delivery only when the user asks or the origin cannot receive results.",
    },
  ])
}
