import { z } from "zod"

const Saved = z.object({
  runID: z.string().default(""),
  selected: z.string().default(""),
  category: z.string().default(""),
  grouping: z.enum(["request", "round"]).default("request"),
  delta: z.boolean().default(false),
  scroll: z.number().nonnegative().default(0),
  records: z.boolean().default(false),
})
const record = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {})

export function contextDashboardState(state: unknown) {
  const value = record(state)
  const saved = Saved.safeParse(value.contextDashboard).data
  const initial = saved ?? Saved.parse({ runID: typeof value.runID === "string" ? value.runID : "" })
  return { ...initial, records: saved ? saved.records : typeof value.nodeID === "string" }
}
