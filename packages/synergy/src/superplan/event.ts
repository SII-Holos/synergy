import z from "zod"
import { BusEvent } from "../bus/bus-event"
import { SuperPlanTypes } from "./types"

export namespace SuperPlanEvent {
  export const Created = BusEvent.define(
    "superplan.run.created",
    z.object({
      run: SuperPlanTypes.Run,
    }),
  )

  export const Updated = BusEvent.define(
    "superplan.run.updated",
    z.object({
      run: SuperPlanTypes.Run,
    }),
  )

  export const EventAppended = BusEvent.define(
    "superplan.event.appended",
    z.object({
      event: SuperPlanTypes.EventInfo,
    }),
  )
}
