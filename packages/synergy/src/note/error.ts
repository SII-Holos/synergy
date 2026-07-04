import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"
import { NoteTypes } from "./types"

export namespace NoteError {
  export const Conflict = NamedError.create(
    "NoteConflictError",
    z.object({
      noteID: z.string(),
      expectedVersion: z.number(),
      note: NoteTypes.Info,
    }),
  )
  export const NotArchived = NamedError.create(
    "NoteNotArchivedError",
    z.object({
      noteID: z.string(),
      message: z.string(),
    }),
  )
}
