import z from "zod"
import { BusEvent } from "../bus/bus-event"
import { LatticeTypes } from "./types"

export namespace LatticeEvent {
  export const Created = BusEvent.define(
    "lattice.run.created",
    z.object({
      run: LatticeTypes.Run,
    }),
  )

  export const Updated = BusEvent.define(
    "lattice.run.updated",
    z.object({
      run: LatticeTypes.Run,
    }),
  )

  export const EventAppended = BusEvent.define(
    "lattice.event.appended",
    z.object({
      event: LatticeTypes.EventInfo,
    }),
  )
}
