import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"

export namespace LoopError {
  export const NotFound = NamedError.create(
    "BlueprintLoopNotFound",
    z.object({
      id: z.string(),
    }),
  )

  export const InvalidTransition = NamedError.create(
    "BlueprintLoopInvalidTransition",
    z.object({
      from: z.string(),
      to: z.string(),
    }),
  )

  export const AlreadyActive = NamedError.create(
    "BlueprintLoopAlreadyActive",
    z.object({
      noteID: z.string(),
      loopID: z.string(),
      sessionID: z.string(),
      status: z.string(),
    }),
  )
}
