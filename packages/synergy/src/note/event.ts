import z from "zod"
import { BusEvent } from "../bus/bus-event"
import { NoteTypes } from "./types"

export namespace NoteEvent {
  export const Created = BusEvent.define(
    "note.created",
    z.object({
      note: NoteTypes.Info,
    }),
  )

  export const Updated = BusEvent.define(
    "note.updated",
    z.object({
      note: NoteTypes.Info,
    }),
  )

  export const Deleted = BusEvent.define(
    "note.deleted",
    z.object({
      id: z.string(),
      scopeID: z.string(),
    }),
  )
}
