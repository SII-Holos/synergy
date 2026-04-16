import z from "zod"
import { BusEvent } from "../bus/bus-event"
import { CortexTypes } from "./types"

export const CortexEvent = {
  TaskCreated: BusEvent.define(
    "cortex.task.created",
    z.object({
      task: CortexTypes.Task,
    }),
  ),
  TaskCompleted: BusEvent.define(
    "cortex.task.completed",
    z.object({
      task: CortexTypes.Task,
    }),
  ),
  TasksUpdated: BusEvent.define(
    "cortex.tasks.updated",
    z.object({
      tasks: z.array(CortexTypes.Task),
    }),
  ),
}
