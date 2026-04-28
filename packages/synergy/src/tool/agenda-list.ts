import z from "zod"
import { Tool } from "./tool"
import { AgendaStore, AgendaTypes } from "../agenda"
import { Instance } from "../scope/instance"
import DESCRIPTION from "./agenda-list.txt"

const parameters = z.object({
  status: AgendaTypes.ItemStatus.optional().describe("Filter by status"),
  tag: z.string().optional().describe("Filter by tag"),
  scope: z
    .enum(["current", "global", "all"])
    .optional()
    .describe(
      "Which items to show: 'current' (project only), 'global' (global only), 'all' (current + global, default)",
    ),
})

function formatTrigger(triggers: AgendaTypes.Trigger[]): string {
  if (triggers.length === 0) return "manual"
  const t = triggers[0]
  switch (t.type) {
    case "cron":
      return `cron "${t.expr}"${t.tz ? ` (${t.tz})` : ""}`
    case "every":
      return `every ${t.interval}`
    case "at":
      return `at ${new Date(t.at).toISOString()}`
    case "delay":
      return `delay ${t.delay}`
    case "watch":
      return `watch (${t.watch.kind})`
    case "webhook":
      return "webhook"
    default:
      return triggers.map((tr) => tr.type).join(", ")
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case "active":
      return "🟢"
    case "paused":
      return "⏸"
    case "done":
      return "✅"
    case "cancelled":
      return "⛔"
    default:
      return "⏳"
  }
}

function formatItem(item: AgendaTypes.Item): string {
  const parts = [`${statusIcon(item.status)} [${item.id}] "${item.title}" — ${item.status}`]
  parts.push(`  Schedule: ${formatTrigger(item.triggers)}`)
  if (item.global) parts.push(`  Scope: global`)
  if (item.tags?.length) parts.push(`  Tags: ${item.tags.join(", ")}`)
  if (item.state.nextRunAt) parts.push(`  Next run: ${new Date(item.state.nextRunAt).toISOString()}`)
  if (item.state.lastRunAt) {
    const status = item.state.lastRunStatus ?? "unknown"
    parts.push(
      `  Last run: ${new Date(item.state.lastRunAt).toISOString()} (${status}${item.state.runCount > 0 ? `, ${item.state.runCount} total` : ""})`,
    )
  }
  return parts.join("\n")
}

export const AgendaListTool = Tool.define("agenda_list", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const scopeFilter = params.scope ?? "all"
    const currentScopeID = Instance.scope.id

    let items: AgendaTypes.Item[]
    switch (scopeFilter) {
      case "current":
        items = await AgendaStore.list(currentScopeID)
        break
      case "global":
        items = await AgendaStore.list("global")
        break
      case "all":
      default:
        items = await AgendaStore.listForScope(currentScopeID)
        break
    }

    if (params.status) {
      items = items.filter((item) => item.status === params.status)
    }
    if (params.tag) {
      items = items.filter((item) => item.tags?.includes(params.tag!))
    }

    if (items.length === 0) {
      const filters: string[] = []
      if (params.status) filters.push(`status=${params.status}`)
      if (params.tag) filters.push(`tag=${params.tag}`)
      if (scopeFilter !== "all") filters.push(`scope=${scopeFilter}`)
      const suffix = filters.length ? ` matching ${filters.join(", ")}` : ""
      return {
        title: "No items",
        output: `No agenda items found${suffix}.`,
        metadata: { count: 0 } as Record<string, any>,
      }
    }

    const output = items.map(formatItem).join("\n\n")
    const header = `${items.length} agenda item${items.length === 1 ? "" : "s"}:`

    return {
      title: `${items.length} item${items.length === 1 ? "" : "s"}`,
      output: `${header}\n\n${output}\n\nActions: agenda_update(id, ...) to modify, agenda_cancel(id) to stop, agenda_trigger(id) to run now, agenda_logs(id) for history.`,
      metadata: { count: items.length } as Record<string, any>,
    }
  },
})
