import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"

export namespace LatticeError {
  export const NotFound = NamedError.create(
    "LatticeRunNotFound",
    z
      .object({
        runID: z.string().optional(),
        sessionID: z.string().optional(),
      })
      .strict()
      .refine((value) => value.runID !== undefined || value.sessionID !== undefined, {
        message: "runID or sessionID is required",
      }),
  )

  export const InvalidPathway = NamedError.create("LatticeInvalidPathway", z.object({ reason: z.string() }).strict())

  export const StateConflict = NamedError.create(
    "LatticeStateConflict",
    z
      .object({
        state: z.string(),
        reason: z.string(),
      })
      .strict(),
  )

  /** @deprecated Use StateConflict. */
  export const PhaseViolation = StateConflict
}
