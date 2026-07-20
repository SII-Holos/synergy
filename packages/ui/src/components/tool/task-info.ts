import { TOOL_TITLE_DESC } from "../tool-title-descriptors"

export function getTaskToolInfo(input: Record<string, unknown>) {
  const description = typeof input.description === "string" ? input.description : undefined
  const agentType = typeof input.subagent_type === "string" ? input.subagent_type : undefined

  return {
    icon: "list-todo" as const,
    title: TOOL_TITLE_DESC.task,
    subtitle: description,
    args: agentType ? [agentType] : undefined,
  }
}
