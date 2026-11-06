import { NamedError } from "@ericsanchezok/synergy-util/error"
import z from "zod"

export namespace LoopError {
  export const SourceUnavailable = NamedError.create("BlueprintLoopSourceUnavailable", z.object({ source: z.string() }))

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

  /**
   * A machine-owned loop cannot start while the session is paused.
   *
   * Only the user releases a pause, so a Loop that `lattice` or a plugin wants
   * to run has to say so instead of starting a turn the drive gate will refuse.
   * The owner decides what a blocked start means for its own lifecycle; this
   * error is the fact, not the policy.
   */
  export const SessionPaused = NamedError.create(
    "BlueprintLoopSessionPaused",
    z.object({
      loopID: z.string(),
      sessionID: z.string(),
      source: z.string(),
    }),
  )
}
