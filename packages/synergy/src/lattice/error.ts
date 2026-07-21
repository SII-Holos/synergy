import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"

export namespace LatticeError {
  export const NotFound = NamedError.create("LatticeRunNotFound", z.object({ sessionID: z.string() }))

  export const InvalidPathway = NamedError.create(
    "LatticeInvalidPathway",
    z.object({
      reason: z.string(),
    }),
  )

  export const PhaseViolation = NamedError.create(
    "LatticePhaseViolation",
    z.object({
      phase: z.string(),
      reason: z.string(),
    }),
  )
}
