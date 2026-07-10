import z from "zod"
import { BusEvent } from "../bus/bus-event"
import { WorkflowTypes } from "./types"

export namespace WorkflowEvent {
  export const RunCreated = BusEvent.define("workflow.run.created", z.object({ run: WorkflowTypes.Run }))

  export const RunUpdated = BusEvent.define("workflow.run.updated", z.object({ run: WorkflowTypes.Run }))

  export const EventAppended = BusEvent.define("workflow.event.appended", z.object({ event: WorkflowTypes.EventInfo }))
}
