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

export type TaskSubagentSummaryItem = {
  id: string
  tool: string
  state: { status: string; title?: string }
}

export function parseTaskSubagentSummary(value: unknown): TaskSubagentSummaryItem[] {
  if (!Array.isArray(value)) return []
  const items: TaskSubagentSummaryItem[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue
    const source = entry as Record<string, unknown>
    if (typeof source.id !== "string" || typeof source.tool !== "string") continue
    const state = source.state && typeof source.state === "object" ? (source.state as Record<string, unknown>) : {}
    const status = typeof state.status === "string" ? state.status : "running"
    const title = typeof state.title === "string" ? state.title : undefined
    items.push({ id: source.id, tool: source.tool, state: { status, title } })
  }
  return items
}
