import z from "zod"
import { BusEvent } from "../bus/bus-event"
import { AgendaTypes } from "./types"

export namespace AgendaEvent {
  export const ItemCreated = BusEvent.define(
    "agenda.item.created",
    z.object({
      item: AgendaTypes.Item,
    }),
  )

  export const ItemUpdated = BusEvent.define(
    "agenda.item.updated",
    z.object({
      item: AgendaTypes.Item,
    }),
  )

  export const ItemDeleted = BusEvent.define(
    "agenda.item.deleted",
    z.object({
      id: z.string(),
      scopeID: z.string(),
    }),
  )
}
