import z from "zod"
import { BusEvent } from "../bus/bus-event"
import { NoteTypes } from "./types"

export namespace NoteEvent {
  export const Created = BusEvent.define(
    "note.created",
    z.object({
      scopeID: z.string(),
      note: NoteTypes.Info,
      meta: NoteTypes.MetaInfo,
    }),
  )

  export const Updated = BusEvent.define(
    "note.updated",
    z.object({
      scopeID: z.string(),
      note: NoteTypes.Info,
      meta: NoteTypes.MetaInfo,
      changed: z.array(NoteTypes.ChangedField),
    }),
  )

  export const Deleted = BusEvent.define(
    "note.deleted",
    z.object({
      id: z.string(),
      scopeID: z.string(),
    }),
  )
  export const Archived = BusEvent.define(
    "note.archived",
    z.object({
      ids: z.array(z.string()),
      scopeID: z.string(),
      metas: z.array(NoteTypes.MetaInfo),
    }),
  )
  export const Unarchived = BusEvent.define(
    "note.unarchived",
    z.object({
      ids: z.array(z.string()),
      scopeID: z.string(),
      metas: z.array(NoteTypes.MetaInfo),
    }),
  )
}
