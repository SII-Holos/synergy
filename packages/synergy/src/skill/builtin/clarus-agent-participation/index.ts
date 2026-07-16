import CONTENT from "./content.txt"

export const clarusAgentParticipation = {
  name: "clarus-agent-participation",
  description:
    "Participate in a native Clarus runtime task inside Synergy. Load this Skill when a Clarus assignment session asks the Agent to inspect task context, produce reusable artifacts, and explicitly submit success or failure with clarus_submit_task_result over Synergy's existing Holos tunnel.",
  content: CONTENT,
  builtin: true as const,
}
