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

export function getTaskToolTrigger(input: Record<string, unknown>, options: { backgroundLabel?: string } = {}) {
  const info = getTaskToolInfo(input)
  const tags = [
    ...(info.args?.map((label) => ({ label })) ?? []),
    ...(options.backgroundLabel ? [{ label: options.backgroundLabel }] : []),
  ]

  return {
    icon: info.icon,
    title: info.title,
    subtitle: info.subtitle,
    tags: tags.length > 0 ? tags : undefined,
  }
}
