import z from "zod"
import { Tool } from "./tool"
import { AgendaStore, AgendaTypes } from "../agenda"
import { Instance } from "../scope/instance"
import DESCRIPTION from "./agenda-list.txt"

const parameters = z.object({
  status: AgendaTypes.ItemStatus.optional().describe("Filter by status"),
  tag: z.string().optional().describe("Filter by tag"),
})

function formatItem(item: AgendaTypes.Item): string {
  const parts = [`- [${item.id}] "${item.title}" — ${item.status}`]
  if (item.tags?.length) parts.push(`  Tags: ${item.tags.join(", ")}`)
  if (item.triggers.length) {
    const types = item.triggers.map((t) => t.type).join(", ")
    parts.push(`  Triggers: ${types}`)
  }
  if (item.state.nextRunAt) parts.push(`  Next run: ${new Date(item.state.nextRunAt).toISOString()}`)
  if (item.state.lastRunAt) {
    const status = item.state.lastRunStatus ?? "unknown"
    parts.push(`  Last run: ${new Date(item.state.lastRunAt).toISOString()} (${status})`)
  }
  if (item.state.runCount > 0) parts.push(`  Runs: ${item.state.runCount}`)
  parts.push(`  Created: ${new Date(item.time.created).toISOString()}`)
  return parts.join("\n")
}

export const AgendaListTool = Tool.define("agenda_list", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    let items = await AgendaStore.listAll()

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
      const suffix = filters.length ? ` matching ${filters.join(", ")}` : ""
      return {
        title: "No items",
        output: `No agenda items found${suffix}.`,
        metadata: { count: 0 } as Record<string, any>,
      }
    }

    const output = items.map(formatItem).join("\n\n")
    const header = `Found ${items.length} agenda item${items.length === 1 ? "" : "s"}:`

    return {
      title: `${items.length} item${items.length === 1 ? "" : "s"}`,
      output: `${header}\n\n${output}`,
      metadata: { count: items.length } as Record<string, any>,
    }
  },
})
