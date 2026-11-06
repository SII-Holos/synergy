import z from "zod"
import { BusEvent } from "../bus/bus-event"
import { CortexTypes } from "./types"

export const CortexEvent = {
  TaskCreated: BusEvent.define(
    "cortex.task.created",
    z.object({
      task: CortexTypes.TaskSummary,
    }),
  ),
  TaskCompleted: BusEvent.define(
    "cortex.task.completed",
    z.object({
      task: CortexTypes.TaskSummary,
    }),
  ),
  TasksUpdated: BusEvent.define(
    "cortex.tasks.updated",
    z.object({
      tasks: z.array(CortexTypes.TaskSummary),
    }),
  ),
}
