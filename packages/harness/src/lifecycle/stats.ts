import { ToolScheduler } from "../session/tool-scheduler"

export function readRuntimeStats() {
  const toolTasks = structuredClone(ToolScheduler.stats())
  return Object.freeze({ toolTasks: Object.freeze({ ...toolTasks, byExecutor: Object.freeze(toolTasks.byExecutor) }) })
}
