import z from "zod"
import { Tool } from "./tool"
import { AgendaStore } from "../agenda"
import DESCRIPTION from "./agenda-logs.txt"

const parameters = z.object({
  id: z.string().describe("Agenda item ID to get logs for"),
  offset: z.coerce.number().default(0).describe("Number of logs to skip"),
  limit: z.coerce.number().default(20).describe("Maximum number of logs to return"),
})

export const AgendaLogsTool = Tool.define("agenda_logs", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>) {
    const { scopeID } = await AgendaStore.find(params.id)
    const runs = await AgendaStore.listRuns(scopeID, params.id)

    const total = runs.length
    const page = runs.slice(params.offset, params.offset + params.limit)

    if (total === 0) {
      return {
        title: "No logs",
        output: `No execution logs found for item ${params.id}.`,
        metadata: { count: 0, total: 0 } as Record<string, any>,
      }
    }

    const lines = page.map((run) => {
      const parts = [`- [${run.id}] ${run.status} — ${run.trigger.type}`]
      if (run.sessionID) parts.push(`  Session: ${run.sessionID}`)
      if (run.duration !== undefined) parts.push(`  Duration: ${run.duration}ms`)
      if (run.error) parts.push(`  Error: ${run.error}`)
      parts.push(`  Started: ${new Date(run.time.started).toISOString()}`)
      if (run.time.completed) parts.push(`  Completed: ${new Date(run.time.completed).toISOString()}`)
      return parts.join("\n")
    })

    const rangeStart = params.offset + 1
    const rangeEnd = params.offset + page.length
    const header = `${total} run${total === 1 ? "" : "s"} (showing ${rangeStart}-${rangeEnd}):`

    return {
      title: `${total} run${total === 1 ? "" : "s"}`,
      output: `${header}\n\n${lines.join("\n\n")}`,
      metadata: { count: page.length, total } as Record<string, any>,
    }
  },
})
