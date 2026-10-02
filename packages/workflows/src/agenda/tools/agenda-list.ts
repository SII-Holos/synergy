import { agendaAgentItem } from "./agent-item"
import z from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { AgendaStore, AgendaTypes } from ".."
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
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

export const AgendaListTool = Tool.define(
  "agenda_list",
  {
    description: DESCRIPTION,
    parameters,
    async execute(params: z.infer<typeof parameters>) {
      const scopeFilter = params.scope ?? "all"
      const currentScopeID = ScopeContext.current.scope.id

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

      return {
        title: `${items.length} item${items.length === 1 ? "" : "s"}`,
        output: JSON.stringify(items.map(agendaAgentItem), null, 2),
        metadata: { count: items.length } as Record<string, any>,
      }
    },
  },
  { activityKind: "object" },
)
